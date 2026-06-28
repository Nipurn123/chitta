// Eval harness: retrieval metrics + end-to-end measurement of searchWithGraph.
import { test, expect, describe } from "bun:test"
import { recallAtK, precisionAtK, reciprocalRank, ndcgAtK } from "../../src/eval/metrics"
import { evaluate, formatReport } from "../../src/eval/harness"
import { generateGoldSet } from "../../src/eval/goldset"
import { buildEmbeddedContext } from "../../src/embedded/index"

describe("retrieval metrics", () => {
  const gold = new Set(["a", "b"])
  test("recall@k", () => {
    expect(recallAtK(["a", "x", "b"], gold, 3)).toBe(1)
    expect(recallAtK(["a", "x", "y"], gold, 3)).toBe(0.5)
    expect(recallAtK(["x", "y"], gold, 3)).toBe(0)
  })
  test("precision@k", () => {
    expect(precisionAtK(["a", "b", "x"], gold, 3)).toBeCloseTo(2 / 3, 5)
  })
  test("MRR - reciprocal of first hit rank", () => {
    expect(reciprocalRank(["x", "a", "b"], gold)).toBe(0.5)
    expect(reciprocalRank(["a"], gold)).toBe(1)
    expect(reciprocalRank(["x", "y"], gold)).toBe(0)
  })
  test("nDCG@k rewards a relevant item ranked higher", () => {
    const better = ndcgAtK(["a", "x"], gold, 2)
    const worse = ndcgAtK(["x", "a"], gold, 2)
    expect(better).toBeGreaterThan(worse)
    expect(ndcgAtK(["a", "b"], gold, 2)).toBeCloseTo(1, 5) // perfect ranking
  })
})

describe("end-to-end eval over searchWithGraph", () => {
  test("measures recall/nDCG on a tiny gold set built from ingested facts", async () => {
    process.env.CONTEXT_EMBEDDINGS = "hash"
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o", "u@x.com", "admin")
    const facts: Array<[string, string]> = [
      ["rec-aviva", "Aviva deploys AI to stop £230M in insurance fraud."],
      ["rec-hsbc", "HSBC expands AI banking partnership with Google Cloud."],
      ["rec-visa", "Visa ChatGPT integration enables AI agent retail purchasing."],
    ]
    for (const [id, text] of facts) await ctx.authorizedIngest("u", { recordId: id, orgId: "o", recordName: id, text, permittedPrincipals: ["u"] })

    const gold = [
      { query: "£230M insurance fraud", gold: ["rec-aviva"] },
      { query: "HSBC Google Cloud banking", gold: ["rec-hsbc"] },
      { query: "Visa ChatGPT retail", gold: ["rec-visa"] },
    ]
    const report = await evaluate(gold, async (q) => {
      const res = await ctx.searchWithGraph(q, "u", "o")
      return res.searchResults.map((r) => r.metadata.recordId as string)
    }, 5)

    expect(report.recall).toBeGreaterThanOrEqual(0.99) // hybrid BM25 should nail all three
    expect(report.mrr).toBeGreaterThanOrEqual(0.99) // and rank the right one first
    expect(formatReport(report)).toContain("recall@5=")
  })

  test("auto-generates a gold set from stored data and measures retrieval", async () => {
    process.env.CONTEXT_EMBEDDINGS = "hash"
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o", "u@x.com", "admin")
    for (const [id, text] of [
      ["rec-1", "Quarterly revenue grew on enterprise subscription expansion in the Nordics."],
      ["rec-2", "The migration to Kubernetes reduced deployment latency across regions."],
      ["rec-3", "Customer churn dropped after the onboarding redesign and tutorial flow."],
    ] as Array<[string, string]>)
      await ctx.authorizedIngest("u", { recordId: id, orgId: "o", recordName: id, text, permittedPrincipals: ["u"] })

    const gold = generateGoldSet(ctx.store, { terms: 5 })
    expect(gold.length).toBe(3) // one query per record
    const report = await evaluate(gold, async (q) => (await ctx.searchWithGraph(q, "u", "o")).searchResults.map((r) => r.metadata.recordId as string), 5)
    // a query built from a record's own salient terms must retrieve that record
    expect(report.recall).toBeGreaterThanOrEqual(0.99)
  })
})
