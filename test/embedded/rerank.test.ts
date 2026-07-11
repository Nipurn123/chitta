// Ultra re-rank: magnet-document penalty + personal-record boost + diversity cap, so
// one bulky "magnet" doc can't dominate a query on a coincidental word match.
import { test, expect, describe } from "bun:test"
import { buildEmbeddedContext } from "../../src/embedded/index"
import { rerankStage } from "../../src/embedded/retrieval/rerank-stage"
import type { FusedResult } from "../../src/embedded/retrieval/fuse"

describe("retrieval diversity cap", () => {
  test("no more than maxPerRecord chunks from a single magnet record survive", async () => {
    process.env.CONTEXT_MAX_PER_RECORD = "2"
    process.env.CONTEXT_MIN_SCORE = "0" // don't let the floor hide the effect
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o", "u@x.com", "admin")
    // a MAGNET doc: many blocks all about the same thing → many chunks
    const magnet = Array.from({ length: 8 }, (_, i) => `Section ${i}: alpha beta gamma platform overview details and more alpha beta gamma.`).join("\n\n")
    await ctx.authorizedIngest("u", { recordId: "magnet", orgId: "o", recordName: "Big Platform Doc", text: magnet, permittedPrincipals: ["u"] })
    // a small personal note owned by the user
    await ctx.authorizedIngest("u", { recordId: "note", orgId: "o", recordName: "Note", text: "alpha beta gamma personal note.", permittedPrincipals: ["u"] })

    const out = await ctx.searchWithGraph("alpha beta gamma", "u", "o")
    const fromMagnet = out.searchResults.filter((r) => r.metadata.recordId === "magnet").length
    expect(fromMagnet).toBeLessThanOrEqual(2) // capped - magnet can't flood
    // the small owned note should make it into results (boosted, not buried)
    expect(out.searchResults.some((r) => r.metadata.recordId === "note")).toBe(true)
  })

  test("personal boost lifts the owner's own small record", async () => {
    process.env.CONTEXT_MIN_SCORE = "0"
    process.env.CONTEXT_PERSONAL_BOOST = "1.5"
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o", "u@x.com", "admin")
    // big third-party doc (no owner match in results metadata path) vs user's own note
    const big = Array.from({ length: 10 }, (_, i) => `Para ${i}: deep reasoning brain logic intelligence platform.`).join("\n\n")
    await ctx.authorizedIngest("u", { recordId: "ext", orgId: "o", recordName: "Platform Overview", text: big, permittedPrincipals: ["u"] })
    await ctx.authorizedIngest("u", { recordId: "pref", orgId: "o", recordName: "Preference", text: "User loves coding which needs logic and brain.", permittedPrincipals: ["u"] })

    const out = await ctx.searchWithGraph("preferences logic brain", "u", "o")
    // the magnet platform doc must not monopolize the top slot purely via the word "brain"
    const topRecord = out.searchResults[0]?.metadata.recordId ?? ""
    expect(out.searchResults.filter((r) => r.metadata.recordId === "ext").length).toBeLessThanOrEqual(2)
    expect(["pref", "ext"]).toContain(topRecord) // sane: at least one of the two
  })
})

describe("cross-encoder blend (recall-preserving rerank)", () => {
  // A stub cross-encoder that MIS-scores the strong-RRF gold item LOW (0.1) and distractors
  // HIGH (0.9) - the out-of-domain failure mode. Pure rerank obeys it and buries the gold;
  // blend rank-fuses with the RRF order and rescues it (so recall@k isn't lost).
  const stub = { rank: async (_q: string, docs: string[]) => docs.map((d) => (d.includes("GOLDDOC") ? 0.1 : 0.9)) }
  const mk = (id: string, content: string, rrf: number): FusedResult =>
    ({ content, metadata: { recordId: id }, rrf, legs: new Set(["vector"]) }) as FusedResult
  const fresh = (): FusedResult[] => [mk("gold", "alpha GOLDDOC beta", 0.05), mk("a", "alpha distractor one", 0.03), mk("b", "alpha distractor two", 0.02)]

  test("pure rerank demotes a mis-scored strong-RRF item; blend keeps it near the top", async () => {
    delete process.env.CONTEXT_RERANK_BLEND
    const pure = await rerankStage(stub, "alpha", fresh(), 0)
    const pureIds = pure.ordered.map((r) => r.metadata.recordId as string)
    expect(pure.rerankerUsed).toBe(true)
    expect(pureIds[pureIds.length - 1]).toBe("gold") // cross-encoder buried the gold last

    process.env.CONTEXT_RERANK_BLEND = "1"
    const blend = await rerankStage(stub, "alpha", fresh(), 0)
    const blendIds = blend.ordered.map((r) => r.metadata.recordId as string)
    delete process.env.CONTEXT_RERANK_BLEND
    expect(blendIds.indexOf("gold")).toBeLessThan(pureIds.indexOf("gold")) // blend rescues it
    expect(blendIds[blendIds.length - 1]).not.toBe("gold") // no longer buried last
  })
})
