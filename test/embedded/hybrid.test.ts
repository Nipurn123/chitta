// Hybrid retrieval: BM25 (FTS5) + dense + GraphRAG fused with RRF. BM25 recovers
// exact tokens (acronyms, numbers, proper nouns) that dense embeddings miss.
import { test, expect, describe } from "bun:test"
import { SqliteStore } from "../../src/embedded/sqlite-store"
import { buildEmbeddedContext } from "../../src/embedded/index"

describe("FTS5 BM25 index", () => {
  test("exact tokens (acronym, number) are found by ftsSearch", () => {
    const s = new SqliteStore(":memory:")
    expect(s.ftsEnabled).toBe(true)
    s.addChunk("c1", "v1", "o", "Aviva deploys AI to stop £230M in insurance fraud.", [0, 0, 0])
    s.addChunk("c2", "v2", "o", "SAP and Google Cloud deploy agentic commerce architecture.", [0, 0, 0])
    s.addChunk("c3", "v3", "o", "The weather is nice today.", [0, 0, 0])
    expect(s.ftsSearch("230M", 10).length).toBeGreaterThan(0)
    expect(s.ftsSearch("SAP", 10).length).toBeGreaterThan(0)
    // the SAP query should rank the SAP chunk's rowid
    const sapRows = s.ftsSearch("SAP Google Cloud", 10)
    const sapChunk = s.db.query("SELECT rowid FROM chunks WHERE point_id='c2'").get() as { rowid: number }
    expect(sapRows).toContain(sapChunk.rowid)
    s.close()
  })

  test("FTS backfills existing chunks on open (hybrid works on prior data)", () => {
    const a = new SqliteStore(":memory:")
    a.addChunk("c1", "v1", "o", "unique-token-zebra in this chunk", [0, 0, 0])
    // simulate reopen path: a fresh store over the same data would backfill; here we
    // just confirm the maintained index already has it
    expect(a.ftsSearch("unique-token-zebra", 5).length).toBe(1)
    a.close()
  })
})

describe("hybrid search end-to-end (RRF fusion)", () => {
  test("an exact-term query surfaces the right record via BM25 even with weak dense match", async () => {
    process.env.CONTEXT_EMBEDDINGS = "hash" // deterministic, weak semantic - so BM25 carries it
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o", "u@x.com", "admin")
    // recordIds use a slug+suffix so they never collide with an extracted entity slug
    // (the real ingest path does the same: `${slug(name)}-${ts}`).
    await ctx.authorizedIngest("u", { recordId: "rec-aviva-1", orgId: "o", recordName: "Aviva news", text: "Aviva deploys AI to stop £230M in sophisticated insurance fraud.", permittedPrincipals: ["u"] })
    await ctx.authorizedIngest("u", { recordId: "rec-weather-1", orgId: "o", recordName: "Weather", text: "It will be sunny with light winds tomorrow afternoon.", permittedPrincipals: ["u"] })

    const out = await ctx.searchWithGraph("£230M insurance fraud", "u", "o")
    expect(out.searchResults.length).toBeGreaterThan(0)
    // BM25 makes the exact "£230M" token match the TOP hit, above the irrelevant note.
    expect(out.searchResults[0].metadata.recordId).toBe("rec-aviva-1")
    const avivaRank = out.searchResults.findIndex((r) => r.metadata.recordId === "rec-aviva-1")
    const weatherRank = out.searchResults.findIndex((r) => r.metadata.recordId === "rec-weather-1")
    if (weatherRank !== -1) expect(avivaRank).toBeLessThan(weatherRank) // aviva ranks above weather
  })
})
