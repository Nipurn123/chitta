// FILTERED-ANN (ACORN / Filtered-DiskANN principle): when a user can see only a small slice of a
// large corpus, the permission set BECOMES the search space - an EXACT scan over accessible
// vectors. This (a) can't leak (inaccessible rows are never in the candidate set, not merely
// post-filtered) and (b) beats a global ANN that over-fetches mostly-inaccessible neighbours and
// truncates the accessible one. Uses the hash embedder (token-overlap similarity) so the crowding
// is deterministic.

import { describe, expect, test } from "bun:test"
import { buildEmbeddedContext } from "../../src/embedded/index"

describe("filtered-ANN (ACL-first dense search)", () => {
  test("a scoped user's relevant record surfaces even under a large inaccessible-but-similar corpus", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("alice", "o", "a@x", "member")
    ctx.ingestor.registerUser("bob", "o", "b@x", "member")

    // Bob privately ingests 300 records that are HIGHLY similar to the query (token overlap) -
    // they would dominate a global ANN's over-fetch window, but Alice can't see any of them.
    for (let i = 0; i < 300; i++)
      await ctx.authorizedIngest("bob", {
        recordId: `bob-${i}`, orgId: "o", recordName: `b${i}`,
        text: "special zephyr quantum ledger topic decommission protocol", permittedPrincipals: ["bob"],
      })
    // Alice privately ingests the record that actually answers her query.
    await ctx.authorizedIngest("alice", {
      recordId: "alice-answer", orgId: "o", recordName: "ans",
      text: "special zephyr quantum ledger rollout is scheduled for March by Alice", permittedPrincipals: ["alice"],
    })

    const res = await ctx.searchWithGraph("when is the special zephyr quantum ledger rollout", "alice", "o")
    const ids = res.searchResults.map((r) => (r.metadata as { recordId?: string }).recordId)
    // Alice's accessible answer is retrieved (exact over her 1 accessible record)...
    expect(ids).toContain("alice-answer")
    // ...and NOTHING of Bob's ever appears (leak-proof by construction: never in the candidate set).
    expect(ids.some((id) => id?.startsWith("bob-"))).toBe(false)
  })

  test("filter-first path is exact: returns the single best accessible chunk", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o", "e", "member")
    await ctx.authorizedIngest("u", { recordId: "r1", orgId: "o", recordName: "n1", text: "the capital of France is Paris", permittedPrincipals: ["u"] })
    await ctx.authorizedIngest("u", { recordId: "r2", orgId: "o", recordName: "n2", text: "bananas are a yellow fruit", permittedPrincipals: ["u"] })
    const res = await ctx.searchWithGraph("what is the capital of France", "u", "o")
    expect((res.searchResults[0]?.metadata as { recordId?: string }).recordId).toBe("r1")
  })
})
