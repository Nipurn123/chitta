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
  kind: string
  occurred_at: number | null
  actor_ids: string
  confidence: number
}

export type MemoryKind = "semantic" | "episodic" | "procedural"

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
  /** Memory typology (default "semantic"). */
  kind?: MemoryKind
  /** EVENT time for episodic memories (valid time), distinct from created_at/updated_at. */
  occurredAt?: number | null
  /** Canonical entity ids involved (episodic actors/objects). */
  actorIds?: string[]
  /** Trust in this fact (0..1); drives confidence-aware belief revision. Default 1. */
  confidence?: number
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
            is_latest, relation, source_record_id, created_at, updated_at,
            kind, occurred_at, actor_ids, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        m.kind ?? "semantic",
        m.occurredAt ?? null,
        JSON.stringify(m.actorIds ?? []),
        m.confidence ?? 1,
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
           AND kind = 'semantic' AND is_latest = 1 AND is_forgotten = 0
           AND (forget_after IS NULL OR forget_after > ?)
         ORDER BY updated_at DESC`,
      )
      .all(...accessibleVids, now) as MemoryRow[]
  }

  /** Episodic memories the caller may see (time-anchored experiences), newest EVENT first.
   *  Not versioned/deduped like facts - each episode is a distinct experience; the caller
   *  ranks by relevance × recency (it holds the query embedding). ACL-scoped like recall. */
  recallEpisodes(accessibleVids: string[], now = Date.now()): MemoryRow[] {
    if (accessibleVids.length === 0) return []
    return this.db
      .query(
        `SELECT * FROM memories
         WHERE virtual_record_id IN (${ph(accessibleVids.length)})
           AND kind = 'episodic' AND is_forgotten = 0
           AND (forget_after IS NULL OR forget_after > ?)
         ORDER BY COALESCE(occurred_at, created_at) DESC`,
      )
      .all(...accessibleVids, now) as MemoryRow[]
  }

  /** Procedural memories the caller may see (learned how-tos / preferences), current only. */
  recallProcedures(accessibleVids: string[], now = Date.now()): MemoryRow[] {
    if (accessibleVids.length === 0) return []
    return this.db
      .query(
        `SELECT * FROM memories
         WHERE virtual_record_id IN (${ph(accessibleVids.length)})
           AND kind = 'procedural' AND is_latest = 1 AND is_forgotten = 0
           AND (forget_after IS NULL OR forget_after > ?)
         ORDER BY updated_at DESC`,
      )
      .all(...accessibleVids, now) as MemoryRow[]
  }

  /** Whether an episode with this subject_key already exists for a record - so re-ingesting
   *  the same document doesn't duplicate the experience (episodic ingest is idempotent). */
  hasEpisode(virtualRecordId: string, subjectKey: string): boolean {
    return !!this.db
      .query("SELECT 1 FROM memories WHERE virtual_record_id = ? AND subject_key = ? AND kind = 'episodic' LIMIT 1")
      .get(virtualRecordId, subjectKey)
  }

  /** Full version history of a memory chain (oldest → newest), for "how did this evolve". */
  history(rootId: string): MemoryRow[] {
    return this.db.query("SELECT * FROM memories WHERE root_id = ? ORDER BY version ASC").all(rootId) as MemoryRow[]
  }

  // ── Temporal reasoning (bi-temporal queries over the version chains) ─────────

  /** Semantic facts as they were believed AS OF transaction-time `t`: for each subject, the
   *  newest version created at/before t, minus any forgotten at/before t. Reconstructs the
   *  memory's past state ("what did we believe on <date>"). ACL-scoped. */
  factsAsOf(accessibleVids: string[], t: number): MemoryRow[] {
    if (accessibleVids.length === 0) return []
    const inList = ph(accessibleVids.length)
    const rows = this.db
      .query(
        `SELECT m.* FROM memories m
         JOIN (SELECT subject_key, MAX(created_at) mc FROM memories
                 WHERE kind = 'semantic' AND virtual_record_id IN (${inList}) AND created_at <= ?
                 GROUP BY subject_key) x
           ON m.subject_key = x.subject_key AND m.created_at = x.mc
         WHERE m.kind = 'semantic' AND m.virtual_record_id IN (${inList}) AND m.created_at <= ?`,
      )
      .all(...accessibleVids, t, ...accessibleVids, t) as MemoryRow[]
    // Exclude anything that had already been forgotten by t (soft-delete before the cutoff).
    return rows.filter((r) => !(r.is_forgotten && r.updated_at <= t))
  }

  /** Every version of every fact where `entityId` is the SUBJECT, oldest → newest - the raw
   *  material for a "how X changed over time" timeline (includes superseded versions). */
  subjectHistory(entityId: string, accessibleVids: string[]): MemoryRow[] {
    if (accessibleVids.length === 0) return []
    return this.db
      .query(
        `SELECT * FROM memories
         WHERE kind = 'semantic' AND virtual_record_id IN (${ph(accessibleVids.length)}) AND subject_key LIKE ?
         ORDER BY created_at ASC, version ASC`,
      )
      .all(...accessibleVids, `${entityId}|%`) as MemoryRow[]
  }

  /** Episodes whose actors include `entityId`, oldest EVENT first - the experiences part of
   *  an entity's timeline. ACL-scoped. (actor_ids is a JSON array of canonical ids.) */
  episodesForActor(entityId: string, accessibleVids: string[]): MemoryRow[] {
    if (accessibleVids.length === 0) return []
    return this.db
      .query(
        `SELECT * FROM memories
         WHERE kind = 'episodic' AND is_forgotten = 0 AND virtual_record_id IN (${ph(accessibleVids.length)})
           AND actor_ids LIKE ?
         ORDER BY COALESCE(occurred_at, created_at) ASC`,
      )
      .all(...accessibleVids, `%"${entityId}"%`) as MemoryRow[]
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

  /** Current count per memory kind (semantic / episodic / procedural) - for discovery/stats. */
  kinds(): { semantic: number; episodic: number; procedural: number } {
    const rows = this.db
      .query("SELECT kind, count(*) c FROM memories WHERE is_latest = 1 AND is_forgotten = 0 GROUP BY kind")
      .all() as Array<{ kind: string; c: number }>
    const out = { semantic: 0, episodic: 0, procedural: 0 }
    for (const r of rows) if (r.kind in out) out[r.kind as keyof typeof out] = r.c
    return out
  }
}
