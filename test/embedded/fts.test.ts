// Keyword (FTS5/BM25) leg: porter stemming, stopword filtering, and the one-time rebuild of an
// index created before stemming existed.
import { test, expect, describe } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildEmbeddedContext } from "../../src/embedded/index"

async function store(path = ":memory:") {
  const ctx = buildEmbeddedContext({ path })
  ctx.ingestor.registerUser("u", "o", "u@x.com", "admin")
  const add = (id: string, text: string) => ctx.authorizedIngest("u", { recordId: id, orgId: "o", recordName: id, text, permittedPrincipals: ["u"] })
  await add("trips", "We planned three road trips along the coast last summer.")
  await add("car", "My car broke down on the highway.")
  await add("filler", "What did you do and what was it that you had with them there?")
  return ctx
}
const contents = (ctx: Awaited<ReturnType<typeof store>>, rowids: number[]) =>
  rowids.map((id) => (ctx.store.db.query("SELECT content FROM chunks WHERE rowid = ?").get(id) as { content: string }).content)

describe("FTS keyword leg", () => {
  test("porter stemming: 'trip' matches 'trips'", async () => {
    const ctx = await store()
    expect(contents(ctx, ctx.store.ftsSearch("trip", 10)).some((c) => c.includes("road trips"))).toBe(true)
  })

  test("stopwords are dropped: a stopword-heavy chunk doesn't match 'what did I do with my car'", async () => {
    const ctx = await store()
    const hits = contents(ctx, ctx.store.ftsSearch("what did I do with my car", 10))
    expect(hits.some((c) => c.includes("car broke down"))).toBe(true)
    expect(hits.some((c) => c.includes("What did you do"))).toBe(false)
  })

  test("a query of only stopwords is still searched as written", async () => {
    const ctx = await store()
    expect(ctx.store.ftsSearch("what was it", 10).length).toBeGreaterThan(0)
  })

  test("an index built before stemming is rebuilt once on open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chitta-fts-"))
    const path = join(dir, "old.db")
    try {
      ;(await store(path)).store.close()
      // simulate a pre-stemming store: default tokenizer, same rows
      const raw = new Database(path)
      raw.exec("DROP TABLE chunks_fts; CREATE VIRTUAL TABLE chunks_fts USING fts5(content); INSERT INTO chunks_fts(rowid, content) SELECT rowid, content FROM chunks;")
      raw.close()

      const ctx = buildEmbeddedContext({ path })
      const ddl = (ctx.store.db.query("SELECT sql FROM sqlite_master WHERE name = 'chunks_fts'").get() as { sql: string }).sql
      expect(ddl).toContain("porter")
      const n = (q: string) => (ctx.store.db.query(q).get() as { n: number }).n
      expect(n("SELECT count(*) n FROM chunks_fts")).toBe(n("SELECT count(*) n FROM chunks"))
      expect(contents(ctx, ctx.store.ftsSearch("trip", 10)).some((c) => c.includes("road trips"))).toBe(true)
      ctx.store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
