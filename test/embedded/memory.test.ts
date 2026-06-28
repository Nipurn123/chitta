// Living-memory layer: atomic memories with version chains (contradiction → supersede),
// forgetting (explicit + TTL), static-vs-dynamic, and - the differentiator vs Supermemory
// - all of it ACL-scoped (you can only recall/forget what you may see). Uses the real
// embedded context + hashing embedder (deterministic via bunfig preload).
import { test, expect, describe, beforeEach } from "bun:test"
import { buildEmbeddedContext, type EmbeddedContext } from "../../src/embedded/index"

const ORG = "acme"

function setup(): EmbeddedContext {
  const ctx = buildEmbeddedContext({ path: ":memory:" })
  ctx.ingestor.registerUser("alice", ORG, "a@acme.com", "admin")
  ctx.ingestor.registerUser("bob", ORG, "b@acme.com", "editor")
  return ctx
}

describe("living memory", () => {
  let ctx: EmbeddedContext
  beforeEach(() => {
    ctx = setup()
  })

  test("contradiction on a functional fact supersedes: latest wins, history kept", async () => {
    await ctx.authorizedIngest("alice", {
      recordId: "r1", orgId: ORG, recordName: "old job", text: "Sarah works at Google",
      relations: [{ from: "Sarah", to: "Google", type: "works_at" }],
    })
    await ctx.authorizedIngest("alice", {
      recordId: "r2", orgId: ORG, recordName: "new job", text: "Sarah works at Meta",
      relations: [{ from: "Sarah", to: "Meta", type: "works_at" }],
    })
    const mems = await ctx.recallMemories("where does Sarah work", "alice", ORG)
    const texts = mems.map((m) => m.memory)
    // current truth = Meta only; the superseded Google fact is NOT in recall
    expect(texts.some((t) => t.includes("Meta"))).toBe(true)
    expect(texts.some((t) => t.includes("Google"))).toBe(false)
    const meta = mems.find((m) => m.memory.includes("Meta"))!
    expect(meta.version).toBe(2) // it's v2 of the chain
    // but history is preserved (non-destructive)
    const hist = ctx.memoryHistory(meta.rootId)
    expect(hist.map((h) => h.memory)).toEqual(["Sarah works at Google", "Sarah works at Meta"])
    expect(hist[0].isLatest).toBe(false)
    expect(hist[1].isLatest).toBe(true)
  })

  test("multi-valued facts coexist; re-asserting the same fact dedups (no new version)", async () => {
    await ctx.authorizedIngest("alice", {
      recordId: "r1", orgId: ORG, recordName: "skills", text: "Sarah knows Python and Rust",
      relations: [
        { from: "Sarah", to: "Python", type: "knows" },
        { from: "Sarah", to: "Rust", type: "knows" },
      ],
    })
    // re-assert one of them from another doc → should NOT create a duplicate
    await ctx.authorizedIngest("alice", {
      recordId: "r2", orgId: ORG, recordName: "skills again", text: "Sarah knows Python",
      relations: [{ from: "Sarah", to: "Python", type: "knows" }],
    })
    const mems = await ctx.recallMemories("what does Sarah know", "alice", ORG, 50)
    const knows = mems.filter((m) => m.memory.startsWith("Sarah knows"))
    expect(knows.length).toBe(2) // Python + Rust, no duplicate Python
    expect(knows.every((m) => m.version === 1)).toBe(true) // multi-valued → independent v1 chains
  })

  test("explicit forget removes a memory from recall (within ACL)", async () => {
    await ctx.authorizedIngest("alice", {
      recordId: "r1", orgId: ORG, recordName: "addr", text: "Alice lives in Berlin",
      relations: [{ from: "Alice", to: "Berlin", type: "lives_in" }],
    })
    expect((await ctx.recallMemories("where does Alice live", "alice", ORG)).length).toBe(1)
    const forgotten = await ctx.forgetMemories("Alice lives in Berlin", "alice", ORG, "moved, retracted")
    expect(forgotten.length).toBe(1)
    expect((await ctx.recallMemories("where does Alice live", "alice", ORG)).length).toBe(0)
    // forget is COHERENT: the underlying typed graph edge is also expired, so graph
    // queries / KGQA relation paths stop asserting it too (history kept, just not live).
    const nb = await ctx.graphQuery.neighbors("Alice", "alice", ORG, "lives_in")
    expect(nb?.neighbors.length ?? 0).toBe(0)
  })

  test("TTL sweep retires dynamic memories but never static ones", async () => {
    process.env.CONTEXT_MEMORY_TTL_DAYS = "7"
    try {
      await ctx.authorizedIngest("alice", {
        recordId: "r1", orgId: ORG, recordName: "facts", text: "Sarah reports to Dana; Sarah born in Paris",
        relations: [
          { from: "Sarah", to: "Dana", type: "reports_to" }, // dynamic → gets a TTL
          { from: "Sarah", to: "Paris", type: "born_in" }, // static → exempt
        ],
      })
    } finally {
      delete process.env.CONTEXT_MEMORY_TTL_DAYS
    }
    // force-expire: backdate every dynamic forget_after into the past, then sweep
    ctx.store.db.query("UPDATE memories SET forget_after = 1 WHERE is_static = 0").run()
    ctx.store.memories.sweep()
    const mems = await ctx.recallMemories("Sarah", "alice", ORG, 50)
    expect(mems.some((m) => m.memory.includes("born in Paris"))).toBe(true) // static survived
    expect(mems.some((m) => m.memory.includes("reports to Dana"))).toBe(false) // dynamic expired
  })

  test("profile synthesis rolls up static + recent facts + related entities (ACL-scoped)", async () => {
    await ctx.authorizedIngest("alice", {
      recordId: "p1", orgId: ORG, recordName: "person", text: "Maya born in Pune; Maya works at Acme; Maya knows Rust",
      relations: [
        { from: "Maya", to: "Pune", type: "born_in" }, // static
        { from: "Maya", to: "Acme", type: "works_at" }, // dynamic
        { from: "Maya", to: "Rust", type: "knows" }, // dynamic, multi-valued
      ],
    })
    const p = (await ctx.buildProfile("Maya", "alice", ORG))!
    expect(p).not.toBeNull()
    expect(p.staticFacts.some((f) => f.includes("born in Pune"))).toBe(true)
    expect(p.recentFacts.some((f) => f.includes("works at Acme"))).toBe(true)
    expect(p.staticFacts.some((f) => f.includes("Acme"))).toBe(false) // works_at is NOT static
    expect(p.related.map((r) => r.toLowerCase())).toContain("acme")
    // ACL: bob (no access to p1, which is private to alice) gets nothing
    expect(await ctx.buildProfile("Maya", "bob", ORG)).toBeNull()
  })

  test("ACL: a user cannot recall OR forget memories from records they can't see", async () => {
    // alice stores a PRIVATE fact (bob is not a permitted principal)
    await ctx.authorizedIngest("alice", {
      recordId: "secret", orgId: ORG, recordName: "secret", text: "Alice married to Jordan",
      permittedPrincipals: [], // private to alice
      relations: [{ from: "Alice", to: "Jordan", type: "married_to" }],
    })
    // alice sees it
    expect((await ctx.recallMemories("who is Alice married to", "alice", ORG)).length).toBe(1)
    // bob does NOT
    expect((await ctx.recallMemories("who is Alice married to", "bob", ORG)).length).toBe(0)
    // and bob cannot forget what he cannot see
    expect((await ctx.forgetMemories("Alice married to Jordan", "bob", ORG)).length).toBe(0)
    // alice's memory is intact
    expect((await ctx.recallMemories("who is Alice married to", "alice", ORG)).length).toBe(1)
  })
})
