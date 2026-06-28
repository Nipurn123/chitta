// Passage-level extraction: a coarse multi-fact digest chunk returns the EXACT line
// matching the query, skipping boilerplate - at read time, no re-ingest.
import { test, expect, describe } from "bun:test"
import { buildEmbeddedContext } from "../../src/embedded/index"

describe("passage extraction over coarse digest chunks", () => {
  test("a multi-fact digest returns the matching FACT line, not the whole chunk", async () => {
    process.env.CONTEXT_EMBEDDINGS = "hash"
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o", "u@x.com", "admin")
    // one giant digest chunk with many facts (like the scraped TechForge pages)
    const digest = [
      "June 19, 2026: SAP and Google Cloud deploy agentic commerce architecture.",
      "June 18, 2026: HSBC expands AI banking partnership with Google Cloud.",
      "June 8, 2026: Aviva deploys AI to stop £230M in sophisticated insurance fraud.",
      "June 11, 2026: Visa ChatGPT integration enables AI agent retail purchasing.",
    ].join("\n")
    await ctx.authorizedIngest("u", { recordId: "rec-digest-1", orgId: "o", recordName: "TechForge digest", text: digest, permittedPrincipals: ["u"] })

    const out = await ctx.searchWithGraph("£230M insurance fraud", "u", "o")
    expect(out.searchResults.length).toBeGreaterThan(0)
    const top = out.searchResults[0].content
    expect(top).toContain("Aviva") // the EXACT fact line
    expect(top).toContain("230M")
    expect(top).not.toContain("SAP") // not the whole digest
    expect(top).not.toContain("Visa")
  })

  test("boilerplate lines inside a chunk are skipped at read time", async () => {
    process.env.CONTEXT_EMBEDDINGS = "hash"
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o", "u@x.com", "admin")
    // NOTE: ingest strips boilerplate, so to test the READ-time skip we add the chunk raw
    ctx.store.db.query("INSERT INTO nodes(id,coll,data) VALUES('rec-x','records',?)").run(
      JSON.stringify({ virtualRecordId: "rec-x", orgId: "o", recordName: "Page", indexingStatus: "COMPLETED" }),
    )
    ctx.store.addEdge("u", "rec-x", "permissions")
    const raw = "Manage Cookie Consent\nAccept\nHSBC expands AI banking partnership with Google Cloud.\nSubscribe"
    const emb = await ctx.embeddings.embedDense(raw)
    ctx.store.addChunk("rec-x#0", "rec-x", "o", raw, emb)

    const out = await ctx.searchWithGraph("HSBC banking partnership", "u", "o")
    const top = out.searchResults[0]?.content ?? ""
    expect(top).toContain("HSBC")
    expect(top.toLowerCase()).not.toContain("cookie")
    expect(top.toLowerCase()).not.toContain("subscribe")
  })

  test("an all-boilerplate chunk is dropped entirely, not returned as fallback", async () => {
    process.env.CONTEXT_EMBEDDINGS = "hash"
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o", "u@x.com", "admin")
    // one real fact record + one pure-boilerplate record
    await ctx.authorizedIngest("u", { recordId: "rec-fact", orgId: "o", recordName: "Fact", text: "HSBC expands AI banking partnership with Google Cloud.", permittedPrincipals: ["u"] })
    ctx.store.db.query("INSERT INTO nodes(id,coll,data) VALUES('rec-junk','records',?)").run(
      JSON.stringify({ virtualRecordId: "rec-junk", orgId: "o", recordName: "Junk", indexingStatus: "COMPLETED" }),
    )
    ctx.store.addEdge("u", "rec-junk", "permissions")
    const junk = "Manage Cookie Consent\nCookie Consent: GDPR-compliant cookie consent banner with Accept/Deny/View preferences options\nSubscribe now\nAccept\nDeny"
    ctx.store.addChunk("rec-junk#0", "rec-junk", "o", junk, await ctx.embeddings.embedDense(junk))

    const out = await ctx.searchWithGraph("HSBC banking", "u", "o")
    expect(out.searchResults.some((r) => r.metadata.recordId === "rec-junk")).toBe(false) // dropped
    expect(out.searchResults.some((r) => r.content.toLowerCase().includes("cookie"))).toBe(false)
  })
})
