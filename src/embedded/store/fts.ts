// FTS5 build/search/reset. Pure structural extraction from sqlite-store.ts -
// identical SQL, identical behavior.

import { Database } from "bun:sqlite"

// Porter stemming on top of unicode61, so "trips"/"trip" and "visited"/"visit" match.
const FTS_DDL = "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(content, tokenize='porter unicode61')"

// BM25 keyword index (SQLite FTS5, built-in - no extension needed). Complements the
// dense vector index: FTS5 nails exact tokens dense embeddings miss (acronyms "SAP",
// numbers "£230M", proper nouns). Backfills existing chunks on first open so hybrid
// search works on prior data without a reindex.
export function tryEnableFts(db: Database): boolean {
  try {
    // A store built before stemming has an unstemmed index: drop it once, and the backfill
    // below rebuilds it from the chunks table (seconds for ~50k chunks; idempotent after).
    const ddl = (db.query("SELECT sql FROM sqlite_master WHERE name = 'chunks_fts'").get() as { sql: string } | null)?.sql
    if (ddl && !/porter/i.test(ddl)) db.exec("DROP TABLE chunks_fts")
    db.exec(FTS_DDL)
    const ftsCount = (db.query("SELECT count(*) c FROM chunks_fts").get() as { c: number }).c
    const chunkCount = (db.query("SELECT count(*) c FROM chunks").get() as { c: number }).c
    if (ftsCount === 0 && chunkCount > 0)
      db.exec("INSERT INTO chunks_fts(rowid, content) SELECT rowid, content FROM chunks")
    return true
  } catch {
    return false // FTS5 unavailable → dense-only, hybrid degrades gracefully
  }
}

// Upsert a chunk row into the FTS index (called as part of addChunk).
export function indexChunkFts(db: Database, rowid: number, content: string): void {
  db.query("DELETE FROM chunks_fts WHERE rowid = ?").run(rowid)
  db.query("INSERT INTO chunks_fts(rowid, content) VALUES (?, ?)").run(rowid, content)
}

// Function words that match nearly every chunk. OR-ed into the FTS query they add cost and
// noise ("what did I do with my car" is about "car"), so they're dropped - unless the query
// is nothing but stopwords, in which case it's searched as written.
export const STOPWORDS = new Set(
  ("a an the and or but if then than so of to in on at for with from by as into about over after before " +
    "is are was were be been being am do does did doing done have has had having can could would should will shall may might must " +
    "i me my mine myself you your yours we us our ours he him his she her hers it its they them their theirs " +
    "this that these those what which who whom whose when where why how there here just also very any some all").split(" "),
)

/** BM25 keyword search → chunk rowids in relevance order (best first). Each query
 *  token is matched as a quoted literal OR-joined, so punctuation/special chars are
 *  safe and ANY matching term contributes (high recall). [] if FTS is unavailable. */
export function ftsSearch(db: Database, ftsEnabled: boolean, query: string, k: number): number[] {
  if (!ftsEnabled) return []
  const raw = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}£$€%.\-]+/gu) ?? []).filter((t) => t.replace(/[^a-z0-9]/g, "").length >= 2))]
  const content = raw.filter((t) => !STOPWORDS.has(t))
  const terms = content.length ? content : raw
  if (!terms.length) return []
  const expr = terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ")
  try {
    return (
      db.query("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?").all(expr, k) as Array<{ rowid: number }>
    ).map((r) => r.rowid)
  } catch {
    return []
  }
}

/** Drop + recreate the BM25 index (e.g. before a full reindex). */
export function resetFts(db: Database, ftsEnabled: boolean): void {
  if (!ftsEnabled) return
  db.exec(`DROP TABLE IF EXISTS chunks_fts; ${FTS_DDL};`)
}
