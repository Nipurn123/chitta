// Memory repository - SQL primitives for the living-memory layer. Pure persistence:
// the CLASSIFICATION logic (is this new fact a contradiction → new version, or an
// independent memory?) lives in ../memory/consolidate.ts; this file just does the
// reads/writes. Every read is ACL-scoped by the caller passing the accessible
// virtual_record_id set (gate-first, like the rest of the store) so no memory can
// leak across a permission boundary - including superseded versions and forgotten rows.

import { Database } from "bun:sqlite"
import { ph } from "./schema"
import { encodeF32 } from "./vector-blob"

export interface MemoryRow {
  id: string
  org_id: string
  virtual_record_id: string
  subject_key: string
  memory: string
  embedding: Uint8Array | string | null
  is_static: number
  is_forgotten: number
  forget_after: number | null
  forget_reason: string | null
  version: number
  parent_id: string | null
  root_id: string | null
  is_latest: number
  relation: string | null
  source_record_id: string | null
  created_at: number
  updated_at: number
}

export interface NewMemory {
  id: string
  orgId: string
  virtualRecordId: string
  subjectKey: string
  memory: string
  embedding: number[]
  isStatic?: boolean
  forgetAfter?: number | null
  version?: number
  parentId?: string | null
  rootId?: string | null
  relation?: string | null
  sourceRecordId?: string | null
}

export class MemoryRepo {
  constructor(private readonly db: Database) {}

  /** The current (live) memory for a subject_key, if any. "Live" = latest, not forgotten. */
  latestBySubject(subjectKey: string): MemoryRow | undefined {
    return this.db
      .query("SELECT * FROM memories WHERE subject_key = ? AND is_latest = 1 AND is_forgotten = 0 ORDER BY version DESC LIMIT 1")
      .get(subjectKey) as MemoryRow | undefined
  }

  insert(m: NewMemory): void {
    const now = Date.now()
    this.db
      .query(
        `INSERT INTO memories
           (id, org_id, virtual_record_id, subject_key, memory, embedding, is_static,
            is_forgotten, forget_after, forget_reason, version, parent_id, root_id,
            is_latest, relation, source_record_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(
        m.id,
        m.orgId,
        m.virtualRecordId,
        m.subjectKey,
        m.memory,
        encodeF32(m.embedding),
        m.isStatic ? 1 : 0,
        m.forgetAfter ?? null,
        m.version ?? 1,
        m.parentId ?? null,
        m.rootId ?? m.id,
        m.relation ?? null,
        m.sourceRecordId ?? null,
        now,
        now,
      )
  }

  /** Close out a memory version: it is no longer the latest (a newer version supersedes it). */
  markSuperseded(id: string): void {
    this.db.query("UPDATE memories SET is_latest = 0, updated_at = ? WHERE id = ?").run(Date.now(), id)
  }

  /** A re-asserted identical fact: just refresh recency (no new version). */
  touch(id: string): void {
    this.db.query("UPDATE memories SET updated_at = ? WHERE id = ?").run(Date.now(), id)
  }

  /** Forget memories by id (soft-delete with a reason). Returns rows affected. */
  forget(ids: string[], reason: string): number {
    if (ids.length === 0) return 0
    const res = this.db
      .query(`UPDATE memories SET is_forgotten = 1, forget_reason = ?, updated_at = ? WHERE id IN (${ph(ids.length)}) AND is_forgotten = 0`)
      .run(reason, Date.now(), ...ids)
    return Number(res.changes)
  }

  /** TTL sweep: forget every dynamic memory whose forget_after has passed. Static
   *  memories (names, birthplaces) are exempt. Cheap; called lazily before recall/ingest. */
  sweep(now = Date.now()): number {
    const res = this.db
      .query(
        `UPDATE memories SET is_forgotten = 1, forget_reason = 'expired (ttl)', updated_at = ?
         WHERE is_forgotten = 0 AND is_static = 0 AND forget_after IS NOT NULL AND forget_after < ?`,
      )
      .run(now, now)
    return Number(res.changes)
  }

  /** Current memories the caller may see: ACL-scoped to the accessible vids, latest
   *  version only, not forgotten, not expired. The gate-first ACL filter - leak-proof
   *  by construction (an inaccessible vid is never in the IN-list). */
  recall(accessibleVids: string[], now = Date.now()): MemoryRow[] {
    if (accessibleVids.length === 0) return []
    return this.db
      .query(
        `SELECT * FROM memories
         WHERE virtual_record_id IN (${ph(accessibleVids.length)})
           AND is_latest = 1 AND is_forgotten = 0
           AND (forget_after IS NULL OR forget_after > ?)
         ORDER BY updated_at DESC`,
      )
      .all(...accessibleVids, now) as MemoryRow[]
  }

  /** Full version history of a memory chain (oldest → newest), for "how did this evolve". */
  history(rootId: string): MemoryRow[] {
    return this.db.query("SELECT * FROM memories WHERE root_id = ? ORDER BY version ASC").all(rootId) as MemoryRow[]
  }

  /** All memory rows (for reindex when the embedder dimension changes). */
  all(): MemoryRow[] {
    return this.db.query("SELECT id, memory FROM memories").all() as MemoryRow[]
  }

  updateEmbedding(id: string, embedding: number[]): void {
    this.db.query("UPDATE memories SET embedding = ? WHERE id = ?").run(encodeF32(embedding), id)
  }

  counts(): { total: number; current: number; forgotten: number } {
    const get = (sql: string) => (this.db.query(sql).get() as { c: number }).c
    return {
      total: get("SELECT count(*) c FROM memories"),
      current: get("SELECT count(*) c FROM memories WHERE is_latest = 1 AND is_forgotten = 0"),
      forgotten: get("SELECT count(*) c FROM memories WHERE is_forgotten = 1"),
    }
  }
}
