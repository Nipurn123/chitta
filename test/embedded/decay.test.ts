// Memory decay / salience: among equally-relevant memories, the FRESH / often-accessed
// one ranks above a STALE one - without ever deleting the stale one.
import { test, expect, describe } from "bun:test"
import { buildEmbeddedContext } from "../../src/embedded/index"

async function two() {
  process.env.CONTEXT_EMBEDDINGS = "hash"
  process.env.CONTEXT_DECAY = "1"
  const ctx = buildEmbeddedContext({ path: ":memory:" })
  ctx.ingestor.registerUser("u", "o", "u@x.com", "admin")
  // two records with IDENTICAL relevant content → decay is the tiebreaker
  for (const id of ["rec-old", "rec-new"])
    await ctx.authorizedIngest("u", { recordId: id, orgId: "o", recordName: id, text: "alpha beta gamma signal payload", permittedPrincipals: ["u"] })
  return ctx
}

describe("memory decay / salience re-ranking", () => {
  test("a stale memory ranks below an equally-relevant fresh one (but is NOT deleted)", async () => {
    const ctx = await two()
    // age rec-old by 300 days (set lastAccessedAt far in the past)
    const old = Date.now() - 300 * 86_400_000
    ctx.store.db.query("UPDATE nodes SET data = json_set(data,'$.lastAccessedAt',?) WHERE id='rec-old'").run(old)
    const out = await ctx.searchWithGraph("alpha beta gamma", "u", "o")
    const ids = out.searchResults.map((r) => r.metadata.recordId)
    expect(ids).toContain("rec-new")
    expect(ids).toContain("rec-old") // stale, still retrievable - NOT deleted
    expect(ids.indexOf("rec-new")).toBeLessThan(ids.indexOf("rec-old")) // fresh ranks higher
  })

  test("retrieval bumps access (frequency) - used memories gain salience", async () => {
    const ctx = await two()
    const before = (ctx.store.db.query("SELECT COALESCE(json_extract(data,'$.accessCount'),0) c FROM nodes WHERE id='rec-new'").get() as { c: number }).c
    await ctx.searchWithGraph("alpha beta gamma", "u", "o")
    const after = (ctx.store.db.query("SELECT COALESCE(json_extract(data,'$.accessCount'),0) c FROM nodes WHERE id='rec-new'").get() as { c: number }).c
    expect(after).toBeGreaterThan(before)
  })
})
