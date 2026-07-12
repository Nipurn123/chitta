// FTS5 build/search/reset. Pure structural extraction from sqlite-store.ts -
// identical SQL, identical behavior.

import { Database } from "bun:sqlite"

// BM25 keyword index (SQLite FTS5, built-in - no extension needed). Complements the
// dense vector index: FTS5 nails exact tokens dense embeddings miss (acronyms "SAP",
// numbers "£230M", proper nouns). Backfills existing chunks on first open so hybrid
// search works on prior data without a reindex.
export function tryEnableFts(db: Database): boolean {
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(content)")
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

/** BM25 keyword search → chunk rowids in relevance order (best first). Each query
 *  token is matched as a quoted literal OR-joined, so punctuation/special chars are
 *  safe and ANY matching term contributes (high recall). [] if FTS is unavailable. */
export function ftsSearch(db: Database, ftsEnabled: boolean, query: string, k: number): number[] {
  if (!ftsEnabled) return []
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}£$€%.\-]+/gu) ?? []).filter((t) => t.replace(/[^a-z0-9]/g, "").length >= 2)
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
  db.exec("DROP TABLE IF EXISTS chunks_fts; CREATE VIRTUAL TABLE chunks_fts USING fts5(content);")
}
