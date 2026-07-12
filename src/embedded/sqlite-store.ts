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
import { openDatabase, useLibsql } from "./store/db"
import { migrate, tryEnableExtensions, tryLoadVec } from "./store/schema"
import * as graph from "./store/nodes-edges"
import * as fts from "./store/fts"
import { ChunkRepo } from "./store/chunks"
import { MemoryRepo } from "./store/memories"
import { AuditRepo } from "./store/audit"
import { EntityAliasRepo } from "./store/entities"
import { resolveCanonical, type Resolution, type ResolveOptions } from "./graph/entity-resolution"
import * as salience from "./store/salience"

export type Json = Record<string, unknown>

export class SqliteStore {
  readonly db: Database
  readonly vecEnabled: boolean
  readonly ftsEnabled: boolean
  readonly memories: MemoryRepo
  readonly audit: AuditRepo
  readonly entities: EntityAliasRepo
  private readonly chunks: ChunkRepo
  // Monotonic data version - bumped on every mutation of the nodes/edges (the graph + ACL).
  // The graph provider memoizes its two expensive ACL/graph lookups against this, so a
  // cache hit is provably identical to a fresh computation (any write that could change the
  // result bumps the version → cache misses → recompute). Salience/decay writes do NOT bump
  // it (they don't change graph topology or ACL), so read-time decay can't thrash the cache.
  private _dataVersion = 0
  get dataVersion(): number {
    return this._dataVersion
  }
  bumpVersion(): void {
    this._dataVersion++
  }

  constructor(path = ":memory:") {
    // "native" = a libSQL handle (for at-rest encryption AND/OR native DiskANN ANN). On this
    // handle the store uses the built-in vector index, not the sqlite-vec extension.
    const native = useLibsql()
    tryEnableExtensions()
    this.db = openDatabase(path) // bun:sqlite by default; libSQL if CONTEXT_DB_KEY or CONTEXT_DISKANN
    // Read-latency pragmas (set once, before migrate). A large page cache is the main
    // lever for both paths - and the ONLY one for the encrypted driver, where decrypted
    // pages are then served from cache (decrypt paid once per page). mmap is a no-op under
    // encryption (pages must pass the decrypt hook), so we only enable it when plaintext.
    // Each is wrapped so an unsupported pragma on the encrypted driver is non-fatal.
    const pragmas = [
      "PRAGMA journal_mode = WAL;",
      "PRAGMA synchronous = NORMAL;",
      "PRAGMA cache_size = -262144;", // 256 MB page cache (negative = KiB)
      "PRAGMA temp_store = MEMORY;",
      ...(native ? [] : ["PRAGMA mmap_size = 1073741824;"]), // 1 GB, bun:sqlite only
    ]
    for (const p of pragmas) {
      try {
        this.db.exec(p)
      } catch {
        /* pragma unsupported under the encrypted driver - non-fatal */
      }
    }
    migrate(this.db)
    // The encrypted (libSQL) driver can't load the sqlite-vec extension (loadExtension is
    // unimplemented and panics across the native boundary), so encrypted mode uses the
    // built-in brute-force cosine path instead of the ANN index - correctness preserved,
    // ANN speedup traded for encryption. FTS5 is built in and works either way.
    this.vecEnabled = native ? false : tryLoadVec(this.db)
    this.ftsEnabled = fts.tryEnableFts(this.db)
    this.chunks = new ChunkRepo(this.db, this.vecEnabled, this.ftsEnabled, native)
    this.memories = new MemoryRepo(this.db)
    this.audit = new AuditRepo(this.db)
    this.entities = new EntityAliasRepo(this.db)
  }

  // ── Entity resolution / coreference ─────────────────────────────────────
  // Decide the ONE canonical entity id a surface form belongs to (folding "Sarah" /
  // "Sarah Chen" / "Ms. Chen" into one), recording aliases so the next mention is O(1).
  // Does not create the node - the caller writes it under the returned id + label. Bumps
  // the data version because an alias/label change can alter the graph the provider
  // memoizes (labels) and future resolution.
  resolveEntity(name: string, type?: string, opts?: ResolveOptions): Resolution | null {
    const r = resolveCanonical(this.entities, name, type, opts)
    if (r) this.bumpVersion()
    return r
  }

  // Fold two already-separate canonicals into one (backfill dedupe of pre-existing data).
  mergeEntities(loser: string, winner: string): number {
    const n = this.entities.mergeEntities(loser, winner)
    this.bumpVersion()
    return n
  }

  // ── Graph: nodes & edges ────────────────────────────────────────────────
  addNode(id: string, coll: string, data: Json = {}): void {
    graph.addNode(this.db, id, coll, data)
    this.bumpVersion()
  }

  addEdge(src: string, dst: string, label: string, opts: { weight?: number; validAt?: number; recordId?: string; confidence?: number } = {}): void {
    graph.addEdge(this.db, src, dst, label, opts)
    this.bumpVersion()
  }

  clearRecordContributions(recordId: string): void {
    graph.clearRecordContributions(this.db, recordId)
    this.bumpVersion()
  }

  supersedeEdge(src: string, label: string, keepDst: string, atTime = Date.now()): number {
    const n = graph.supersedeEdge(this.db, src, label, keepDst, atTime)
    this.bumpVersion()
    return n
  }

  expireEdges(src: string, label: string, dst?: string): number {
    const n = graph.expireEdges(this.db, src, label, dst)
    this.bumpVersion()
    return n
  }

  backfillEdgeProvenance(): number {
    const n = graph.backfillEdgeProvenance(this.db)
    this.bumpVersion()
    return n
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

  /** True when an ANN index is serving queries (vec0 plaintext, or libSQL native DiskANN
   *  under encryption). False ⇒ the fast BLOB brute-force path is used. */
  get annEnabled(): boolean {
    return this.chunks.annEnabled
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
