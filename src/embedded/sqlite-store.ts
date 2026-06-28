// Embedded store schema (bun:sqlite). A generic property-graph (nodes + edges)
// plus a chunks table holding payloads and dense vectors. One file = the whole
// knowledge base - no servers. This is what makes the single-binary path work.
//
// Vector search adapts: if an extension-capable SQLite is available it loads
// sqlite-vec and maintains a `vec_chunks` ANN index (the zvec-style fast path,
// in-process, same file); otherwise it transparently falls back to brute-force
// cosine. Either way the public API and the VectorDBService interface are identical.
//
// This file is a thin FACADE: it owns the single bun:sqlite Database and delegates
// to focused modules under ./store/ (schema/migrations, graph nodes+edges, chunks+
// vec ANN, FTS5, salience). Pure structural refactor - identical SQL, identical
// behavior. The public surface of SqliteStore is preserved exactly.

import { Database } from "bun:sqlite"
import { migrate, tryEnableExtensions, tryLoadVec } from "./store/schema"
import * as graph from "./store/nodes-edges"
import * as fts from "./store/fts"
import { ChunkRepo } from "./store/chunks"
import * as salience from "./store/salience"

export type Json = Record<string, unknown>

export class SqliteStore {
  readonly db: Database
  readonly vecEnabled: boolean
  readonly ftsEnabled: boolean
  private readonly chunks: ChunkRepo

  constructor(path = ":memory:") {
    tryEnableExtensions()
    this.db = new Database(path)
    this.db.exec("PRAGMA journal_mode = WAL;")
    migrate(this.db)
    this.vecEnabled = tryLoadVec(this.db)
    this.ftsEnabled = fts.tryEnableFts(this.db)
    this.chunks = new ChunkRepo(this.db, this.vecEnabled, this.ftsEnabled)
  }

  // ── Graph: nodes & edges ────────────────────────────────────────────────
  addNode(id: string, coll: string, data: Json = {}): void {
    graph.addNode(this.db, id, coll, data)
  }

  addEdge(src: string, dst: string, label: string, opts: { weight?: number; validAt?: number; recordId?: string; confidence?: number } = {}): void {
    graph.addEdge(this.db, src, dst, label, opts)
  }

  clearRecordContributions(recordId: string): void {
    graph.clearRecordContributions(this.db, recordId)
  }

  supersedeEdge(src: string, label: string, keepDst: string, atTime = Date.now()): number {
    return graph.supersedeEdge(this.db, src, label, keepDst, atTime)
  }

  backfillEdgeProvenance(): number {
    return graph.backfillEdgeProvenance(this.db)
  }

  // ── Salience / decay ────────────────────────────────────────────────────
  recordSalience(recordIds: string[]): Map<string, { lastAccessedAt: number; accessCount: number; importance: number }> {
    return salience.recordSalience(this.db, recordIds)
  }

  touchRecords(recordIds: string[]): void {
    salience.touchRecords(this.db, recordIds)
  }

  // ── Chunks + vec0 ANN ───────────────────────────────────────────────────
  addChunk(pointId: string, virtualRecordId: string, orgId: string, content: string, embedding: number[]): void {
    this.chunks.addChunk(pointId, virtualRecordId, orgId, content, embedding)
  }

  knnSearch(queryVec: number[], k: number): Array<{ rowid: number; distance: number }> {
    return this.chunks.knnSearch(queryVec, k)
  }

  resetVec(): void {
    this.chunks.resetVec()
  }

  // ── FTS5 keyword index ──────────────────────────────────────────────────
  ftsSearch(query: string, k: number): number[] {
    return fts.ftsSearch(this.db, this.ftsEnabled, query, k)
  }

  resetFts(): void {
    fts.resetFts(this.db, this.ftsEnabled)
  }

  close(): void {
    this.db.close()
  }
}
