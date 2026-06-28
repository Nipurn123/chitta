// Chunk persistence + vec0 ANN index + knnSearch. Pure structural extraction from
// sqlite-store.ts - identical SQL, identical behavior.
//
// The vec0 ANN table is created lazily once we know the embedding dimension, so the
// mutable `vecDim` state lives in a small repo object owned by the facade.

import { Database } from "bun:sqlite"
import { indexChunkFts } from "./fts"

// Build a JSON-array literal for a vec0 embedding, asserting every value is a finite
// number. Used only on the libSQL/encrypted path (which rejects bound-param vec inserts).
// Because the output contains only digits, '.', '-', 'e', and ',', it carries no SQL
// injection surface.
function vecLiteral(embedding: number[]): string {
  const parts = embedding.map((x) => {
    if (typeof x !== "number" || !Number.isFinite(x)) throw new Error("invalid embedding value (non-finite)")
    return x
  })
  return `[${parts.join(",")}]`
}

export class ChunkRepo {
  private vecDim = 0

  constructor(
    private readonly db: Database,
    private readonly vecEnabled: boolean,
    private readonly ftsEnabled: boolean,
    // libSQL (encrypted mode) panics on BOUND-param vec0 inserts, so on that driver we
    // build a validated literal insert instead (numbers only → no injection surface).
    private readonly encrypted = false,
  ) {}

  // The vec0 ANN table is created lazily once we know the embedding dimension.
  private ensureVec(dim: number): void {
    if (!this.vecEnabled || this.vecDim) return
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[${dim}] distance_metric=cosine)`)
    this.vecDim = dim
  }

  addChunk(pointId: string, virtualRecordId: string, orgId: string, content: string, embedding: number[]): void {
    const res = this.db
      .query("INSERT OR REPLACE INTO chunks (point_id, virtual_record_id, org_id, content, embedding) VALUES (?, ?, ?, ?, ?)")
      .run(pointId, virtualRecordId, orgId, content, JSON.stringify(embedding))
    const rowid = Number(res.lastInsertRowid)
    if (this.vecEnabled) {
      this.ensureVec(embedding.length)
      if (this.encrypted) {
        // libSQL path: validated literal SQL (rowid is our integer; embedding is a
        // float array we produced — every element checked finite → safe to inline).
        const rid = Math.trunc(rowid)
        const lit = vecLiteral(embedding)
        this.db.exec(`DELETE FROM vec_chunks WHERE rowid = ${rid}`)
        this.db.exec(`INSERT INTO vec_chunks(rowid, embedding) VALUES (${rid}, '${lit}')`)
      } else {
        this.db.query("DELETE FROM vec_chunks WHERE rowid = ?").run(rowid)
        this.db.query("INSERT INTO vec_chunks(rowid, embedding) VALUES (?, ?)").run(rowid, JSON.stringify(embedding))
      }
    }
    if (this.ftsEnabled) {
      indexChunkFts(this.db, rowid, content)
    }
  }

  /** ANN KNN over the vec0 index → [{rowid, distance}] (cosine distance). Returns
   *  [] if the index isn't present/usable (e.g. data written by a non-vec store, a
   *  query-only process, or a dim mismatch) - the caller then falls back to brute-force. */
  knnSearch(queryVec: number[], k: number): Array<{ rowid: number; distance: number }> {
    if (!this.vecEnabled) return []
    try {
      return this.db
        .query("SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT ?")
        .all(JSON.stringify(queryVec), k) as Array<{ rowid: number; distance: number }>
    } catch {
      return [] // vec_chunks missing or incompatible → brute-force handles it
    }
  }

  /** Drop the ANN index (e.g. before reindexing with a different embedder/dim). */
  resetVec(): void {
    if (!this.vecEnabled) return
    this.db.exec("DROP TABLE IF EXISTS vec_chunks")
    this.vecDim = 0
  }
}
