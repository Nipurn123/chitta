// Working memory → consolidation: session items stay ephemeral (invisible to long-term
// recall) until consolidate() promotes the salient few - repeated, explicitly important,
// or referenced multiple times - and drops the rest. Stale sessions expire wholesale.
// Deterministic rules, no LLM; hashing embedder via bunfig preload.
import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { buildEmbeddedContext, type EmbeddedContext } from "../../src/embedded/index"
import { WorkingMemory } from "../../src/embedded/working-memory"

const ORG = "acme"
const HOUR = 3_600_000

let ctx: EmbeddedContext
let wm: WorkingMemory
beforeEach(() => {
  ctx = buildEmbeddedContext({ path: ":memory:" })
  ctx.ingestor.registerUser("alice", ORG, "a@acme.com", "admin")
  wm = new WorkingMemory(ctx.store.db, ctx.embeddings)
})
afterEach(() => {
  delete process.env.CONTEXT_WM_TTL_HOURS
})

describe("working memory → consolidation", () => {
  test("ephemeral session items never appear in long-term recall", async () => {
    wm.note("s1", "user is idly wondering about llamas")
    wm.note("s1", "user is idly wondering about llamas") // salient, but NOT consolidated yet
    expect(wm.items("s1").length).toBe(1) // re-noting dedupes into repeat_count
    expect(wm.items("s1")[0].repeat_count).toBe(2)
    // nothing leaked into the memories table or the recall surface
    expect(ctx.store.memories.counts().total).toBe(0)
    expect((await ctx.recallMemories("llamas", "alice", ORG, 50)).length).toBe(0)
  })

  test("consolidate() promotes the salient (repeated / important / referenced), drops the noise", async () => {
    // an accessible ACL anchor for the promoted memories (vid defaults to the recordId)
    await ctx.authorizedIngest("alice", { recordId: "sess", orgId: ORG, recordName: "session anchor", text: "session anchor" })
    const before = ctx.store.memories.counts().total

    wm.note("s1", "prefers Bun over Node for all tooling") // repeated → salient
    wm.note("s1", "prefers Bun over Node for all tooling")
    wm.note("s1", "ship the memory layer by Friday", { important: true }) // flagged → salient
    const ref = wm.note("s1", "staging db lives at 10.0.0.7") // referenced twice → salient
    wm.markReferenced("s1", ref)
    wm.markReferenced("s1", ref)
    wm.note("s1", "the weather is nice today") // noise
    const once = wm.note("s1", "mentioned once in passing") // one reference is NOT enough
    wm.markReferenced("s1", once)

    const res = await wm.consolidate("s1", { orgId: ORG, virtualRecordId: "sess" })
    expect(res.promoted.length).toBe(3)
    expect(res.dropped).toBe(2)
    expect(ctx.store.memories.counts().total).toBe(before + 3)
    expect(wm.items("s1").length).toBe(0) // working memory empties - promoted or not

    // the salient survived into long-term recall; the chatter did not
    const texts = (await ctx.recallMemories("session preferences and plans", "alice", ORG, 50)).map((m) => m.memory)
    expect(texts).toContain("prefers Bun over Node for all tooling")
    expect(texts).toContain("ship the memory layer by Friday")
    expect(texts.some((t) => t.includes("10.0.0.7"))).toBe(true)
    expect(texts.some((t) => t.includes("weather"))).toBe(false)
    expect(texts.some((t) => t.includes("in passing"))).toBe(false)
  })

  test("re-promoting the same salient item from a later session dedupes (refresh, not duplicate)", async () => {
    await ctx.authorizedIngest("alice", { recordId: "sess", orgId: ORG, recordName: "session anchor", text: "session anchor" })
    const before = ctx.store.memories.counts().total
    wm.note("s1", "prefers Bun over Node for all tooling")
    wm.note("s1", "prefers Bun over Node for all tooling")
    await wm.consolidate("s1", { orgId: ORG, virtualRecordId: "sess" })
    // a later session re-learns the same thing
    wm.note("s2", "prefers Bun over Node for all tooling")
    wm.note("s2", "prefers Bun over Node for all tooling")
    const res = await wm.consolidate("s2", { orgId: ORG, virtualRecordId: "sess" })
    expect(res.promoted.length).toBe(1) // survived consolidation again...
    expect(ctx.store.memories.counts().total).toBe(before + 1) // ...but ONE memory, not two
  })

  test("stale sessions auto-expire (CONTEXT_WM_TTL_HOURS, default 24h)", async () => {
    wm.note("s1", "important but abandoned", { important: true })
    // age the whole session past the default TTL
    ctx.store.db.query("UPDATE working_memory SET last_seen_at = ?").run(Date.now() - 25 * HOUR)

    // a longer TTL keeps it alive...
    process.env.CONTEXT_WM_TTL_HOURS = "48"
    expect(wm.items("s1").length).toBe(1)

    // ...the default (24h) sweeps it on the next touch, even though it was "important"
    delete process.env.CONTEXT_WM_TTL_HOURS
    expect(wm.items("s1").length).toBe(0)

    // consolidating an expired session promotes nothing - it was forgotten wholesale
    const res = await wm.consolidate("s1", { orgId: ORG, virtualRecordId: "sess" })
    expect(res.promoted.length).toBe(0)
    expect(res.dropped).toBe(0)
    expect(ctx.store.memories.counts().total).toBe(0)
  })
})
