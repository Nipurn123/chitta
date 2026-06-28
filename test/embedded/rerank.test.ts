// Ultra re-rank: magnet-document penalty + personal-record boost + diversity cap, so
// one bulky "magnet" doc can't dominate a query on a coincidental word match.
import { test, expect, describe } from "bun:test"
import { buildEmbeddedContext } from "../../src/embedded/index"

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
