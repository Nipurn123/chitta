// Chunk persistence + vec0 ANN index + knnSearch. Pure structural extraction from
// sqlite-store.ts - identical SQL, identical behavior.
//
// The vec0 ANN table is created lazily once we know the embedding dimension, so the
// mutable `vecDim` state lives in a small repo object owned by the facade.

import { Database } from "bun:sqlite"
import { indexChunkFts } from "./fts"
import { encodeF32 } from "./vector-blob"

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
  // Encrypted mode can't load sqlite-vec, but libSQL has a NATIVE vector index (DiskANN)
  // built into the engine - no extension load - so we get real ANN while encrypted. We try
  // it optimistically and flip this off (→ brute-force fallback) if any native-vector SQL
  // fails, so encrypted mode can never break even on an older libSQL without native vector.
  private nativeOk: boolean
  private nativeDim = 0

  constructor(
    private readonly db: Database,
    private readonly vecEnabled: boolean,
    private readonly ftsEnabled: boolean,
    // libSQL (encrypted mode) panics on BOUND-param vec0 inserts, so on that driver we
    // build a validated literal insert instead (numbers only → no injection surface).
    private readonly encrypted = false,
  ) {
    this.nativeOk = encrypted // only the libSQL/encrypted driver has native vector
  }

  // The vec0 ANN table is created lazily once we know the embedding dimension.
  private ensureVec(dim: number): void {
    if (!this.vecEnabled || this.vecDim) return
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[${dim}] distance_metric=cosine)`)
    this.vecDim = dim
  }

  // libSQL native vector index (DiskANN), created lazily at the first known dim. Lives in
  // the SAME (encrypted) database file - no extension, so it works under encryptionKey.
  private ensureNative(dim: number): void {
    if (this.nativeDim) return
    this.db.exec(`CREATE TABLE IF NOT EXISTS vec_native (rowid INTEGER PRIMARY KEY, embedding F32_BLOB(${dim}))`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS vec_native_idx ON vec_native (libsql_vector_idx(embedding, 'metric=cosine'))`)
    this.nativeDim = dim
  }

  /** Whether an ANN index is serving queries (vec0 for plaintext, native DiskANN for
   *  encrypted). When false, retrieval uses the (BLOB + dot-product) brute-force path. */
  get annEnabled(): boolean {
    return this.vecEnabled || (this.encrypted && this.nativeOk)
  }

  addChunk(pointId: string, virtualRecordId: string, orgId: string, content: string, embedding: number[]): void {
    // Embedding stored as a compact Float32 BLOB (not JSON TEXT): no parse on read, ~2-3x
    // smaller, zero-copy decode in the brute-force path. The vec0 ANN path below still gets
    // the in-memory number[] directly, so the index format is unaffected.
    const res = this.db
      .query("INSERT OR REPLACE INTO chunks (point_id, virtual_record_id, org_id, content, embedding) VALUES (?, ?, ?, ?, ?)")
      .run(pointId, virtualRecordId, orgId, content, encodeF32(embedding))
    const rowid = Number(res.lastInsertRowid)
    // Encrypted mode: maintain the libSQL NATIVE vector index (DiskANN) for ANN under
    // encryption. Any failure (older libSQL, dim mismatch) flips to brute-force fallback.
    if (this.encrypted && this.nativeOk) {
      try {
        this.ensureNative(embedding.length)
        const rid = Math.trunc(rowid)
        this.db.query("DELETE FROM vec_native WHERE rowid = ?").run(rid)
        this.db.query("INSERT INTO vec_native (rowid, embedding) VALUES (?, vector32(?))").run(rid, JSON.stringify(embedding))
      } catch {
        this.nativeOk = false // native vector unavailable → brute-force cosine still serves
      }
    }
    if (this.vecEnabled) {
      // Never let the ANN write crash an ingest: if the embedding dim doesn't match an
      // existing vec0 index (the embedder changed for this DB), sqlite-vec throws. We skip
      // the ANN row (brute-force cosine still serves retrieval) — reconcile() upstream
      // detects the dim change and reindexes the whole DB to the current embedder.
      try {
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
      } catch {
        /* dim mismatch / vec unavailable → ANN skipped for this chunk; reconcile fixes it */
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
    // Encrypted: libSQL native DiskANN via vector_top_k (no extension). vector_top_k returns
    // rowids; we join back to get the cosine distance the caller scores with.
    if (this.encrypted && this.nativeOk) {
      try {
        const json = JSON.stringify(queryVec)
        return this.db
          .query(
            `SELECT t.id AS rowid, vector_distance_cos(n.embedding, vector32(?)) AS distance
             FROM vector_top_k('vec_native_idx', vector32(?), ?) t
             JOIN vec_native n ON n.rowid = t.id`,
          )
          .all(json, json, k) as Array<{ rowid: number; distance: number }>
      } catch {
        this.nativeOk = false // fall through to brute-force
        return []
      }
    }
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
    if (this.encrypted) {
      try {
        this.db.exec("DROP INDEX IF EXISTS vec_native_idx")
        this.db.exec("DROP TABLE IF EXISTS vec_native")
      } catch {
        /* ignore */
      }
      this.nativeDim = 0
      this.nativeOk = this.encrypted
    }
    if (!this.vecEnabled) return
    this.db.exec("DROP TABLE IF EXISTS vec_chunks")
    this.vecDim = 0
  }
}
