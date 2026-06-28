// Cross-encoder reranker wiring: an injected reranker reorders the final results;
// an unavailable reranker (returns null) leaves the RRF order untouched.
import { test, expect, describe } from "bun:test"
import { buildEmbeddedContext } from "../../src/embedded/index"
import type { Reranker } from "../../src/embedded/reranker"

async function ctxWith(reranker?: Reranker) {
  process.env.CONTEXT_EMBEDDINGS = "hash"
  const ctx = buildEmbeddedContext({ path: ":memory:", reranker })
  ctx.ingestor.registerUser("u", "o", "u@x.com", "admin")
  for (const [id, text] of [
    ["rec-a", "Aviva deploys AI to stop insurance fraud."],
    ["rec-b", "HSBC banking partnership with Google Cloud."],
    ["rec-c", "Visa ChatGPT retail purchasing."],
  ] as Array<[string, string]>)
    await ctx.authorizedIngest("u", { recordId: id, orgId: "o", recordName: id, text, permittedPrincipals: ["u"] })
  return ctx
}

describe("cross-encoder reranker stage", () => {
  test("an injected reranker reorders results by its scores", async () => {
    // fake reranker: prefer whichever doc mentions "Visa", regardless of RRF order
    const fake: Reranker = {
      async rank(_q, docs) {
        return docs.map((d) => (/visa/i.test(d) ? 100 : 1))
      },
    }
    const ctx = await ctxWith(fake)
    const res = await ctx.searchWithGraph("AI partnership", "u", "o")
    expect(res.searchResults[0].content.toLowerCase()).toContain("visa") // reranker won
  })

  test("an unavailable reranker (null) leaves retrieval working (RRF order)", async () => {
    const nullReranker: Reranker = { async rank() { return null } }
    const ctx = await ctxWith(nullReranker)
    const res = await ctx.searchWithGraph("HSBC banking", "u", "o")
    expect(res.searchResults.length).toBeGreaterThan(0)
    expect(res.searchResults[0].metadata.recordId).toBe("rec-b") // BM25/RRF still ranks HSBC #1
  })
})
