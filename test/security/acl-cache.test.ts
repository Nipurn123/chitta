// The ACL/graph provider memoizes its two expensive lookups, keyed by the store's
// data-version. This MUST never serve a stale permission view: any write that could change
// access bumps the version → the next read recomputes. These tests prove invalidation for
// the security-critical cases (a newly shared record becomes visible; a new fact appears in
// the graph) right after a read has populated the cache.
import { test, expect, describe, beforeEach } from "bun:test"
import { buildEmbeddedContext, type EmbeddedContext } from "../../src/embedded/index"

const ORG = "acme"

function setup(): EmbeddedContext {
  const ctx = buildEmbeddedContext({ path: ":memory:" })
  ctx.ingestor.registerUser("alice", ORG, "a@acme.com", "admin")
  ctx.ingestor.registerUser("bob", ORG, "b@acme.com", "editor")
  return ctx
}

const visibleTo = async (ctx: EmbeddedContext, user: string) => {
  const acc = await ctx.graph.getAccessibleVirtualRecordIds({ userId: user, orgId: ORG })
  return new Set(Object.keys(acc))
}

describe("ACL cache invalidation (no stale permissions)", () => {
  let ctx: EmbeddedContext
  beforeEach(() => {
    ctx = setup()
  })

  test("a record shared AFTER a cached read becomes visible on the next read", async () => {
    // bob reads first → caches his (empty) accessible set
    expect((await visibleTo(ctx, "bob")).size).toBe(0)
    // alice stores a doc and shares it with bob
    await ctx.authorizedIngest("alice", {
      recordId: "shared", orgId: ORG, recordName: "Shared", text: "quarterly numbers",
      permittedPrincipals: ["bob"],
    })
    // bob's NEXT read must reflect the new grant (cache invalidated by the write)
    expect((await visibleTo(ctx, "bob")).has("shared")).toBe(true)
  })

  test("revoking/deleting a record after a cached read removes it on the next read", async () => {
    await ctx.authorizedIngest("alice", {
      recordId: "doc", orgId: ORG, recordName: "Doc", text: "secret", permittedPrincipals: ["bob"],
    })
    expect((await visibleTo(ctx, "bob")).has("doc")).toBe(true) // caches bob's view incl. doc
    ctx.deleteRecord("alice", "doc") // raw node/edge deletes → must still invalidate
    expect((await visibleTo(ctx, "bob")).has("doc")).toBe(false)
  })

  test("getKnowledgeGraph reflects a relation added after it was cached", async () => {
    await ctx.authorizedIngest("alice", {
      recordId: "r1", orgId: ORG, recordName: "r1", text: "Acme partners with Globex",
      relations: [{ from: "Acme", to: "Globex", type: "partners_with" }],
    })
    const acc1 = Object.values(await ctx.graph.getAccessibleVirtualRecordIds({ userId: "alice", orgId: ORG }))
    const kg1 = ctx.graph.getKnowledgeGraph([...new Set(acc1)]) // populate kg cache
    expect(kg1.relations.length).toBe(1)
    await ctx.authorizedIngest("alice", {
      recordId: "r2", orgId: ORG, recordName: "r2", text: "Globex acquired Initech",
      relations: [{ from: "Globex", to: "Initech", type: "acquired" }],
    })
    const acc2 = Object.values(await ctx.graph.getAccessibleVirtualRecordIds({ userId: "alice", orgId: ORG }))
    const kg2 = ctx.graph.getKnowledgeGraph([...new Set(acc2)])
    expect(kg2.relations.length).toBe(2) // the new relation is present, not the stale single-edge cache
  })

  test("repeated identical reads are served from cache (same result, no drift)", async () => {
    await ctx.authorizedIngest("alice", {
      recordId: "r1", orgId: ORG, recordName: "r1", text: "hello world", permittedPrincipals: [],
    })
    const a = await visibleTo(ctx, "alice")
    const b = await visibleTo(ctx, "alice")
    expect([...a].sort()).toEqual([...b].sort()) // cache hit is identical to a fresh compute
  })
})
