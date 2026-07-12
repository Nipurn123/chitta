// Memory repository - SQL primitives for the living-memory layer. Pure persistence:
// the CLASSIFICATION logic (is this new fact a contradiction → new version, or an
// independent memory?) lives in ../memory/consolidate.ts; this file just does the
// reads/writes. Every read is ACL-scoped by the caller passing the accessible
// virtual_record_id set (gate-first, like the rest of the store) so no memory can
// leak across a permission boundary - including superseded versions and forgotten rows.

import { Database } from "bun:sqlite"
import { ph } from "./schema"
import { encodeF32 } from "./vector-blob"

/** Membership view of the ACL scope for belief revision. A real Set<string> satisfies it; the
 *  ingest path passes a LAZY implementation whose `.has` does a targeted, memoized ACL check per
 *  record - so revision never materializes the whole accessible set. Only `.has` + `.size` used. */
export interface ScopeSet {
  has(id: string): boolean
  readonly size: number
}

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
  use_count: number
  last_used_at: number | null
  /** Computed at read time by the recall methods (NOT a column): the blended
   *  recency x frequency x importance score this row was ranked by. */
  strength?: number
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

// ── Usage-reinforced strength (testing effect / ACT-R activation) ────────────
// Memories that get recalled AND used strengthen; unused ones decay. The retrieval
// layer calls reinforce() with the ids it actually returned; the recall methods then
// rank by strength = recency x frequency x importance:
//   • recency   - exponential decay from the LAST time the memory was touched (used,
//     or written/updated if never used), half-life CONTEXT_MEMORY_HALFLIFE_DAYS.
//     Using a memory resets its clock - so an unused memory decays, a used one doesn't.
//   • frequency - log-dampened use_count (the 10th recall matters less than the 2nd).
//   • importance - the write-time confidence score (trust in the fact).
// Ranking only - a weak memory is outranked, never deleted (same philosophy as the
// record-level decay stage). CONTEXT_MEMORY_REINFORCE=0|false|off falls back to the
// legacy write-recency order; usage is still TRACKED so re-enabling loses nothing.

function reinforceOn(): boolean {
  return !/^(0|false|off)$/i.test(process.env.CONTEXT_MEMORY_REINFORCE ?? "1")
}

function halflifeMs(): number {
  return Math.max(1, Number(process.env.CONTEXT_MEMORY_HALFLIFE_DAYS ?? 30)) * 864e5
}

/** Blended strength of one memory row at time `now`. `baseTime` overrides the write-time
 *  anchor (episodic rows anchor on EVENT time, not ingestion time). Exported so the
 *  retrieval layer can blend the same score into semantic-similarity ranking. */
export function memoryStrength(
  r: Pick<MemoryRow, "updated_at" | "use_count" | "last_used_at" | "confidence">,
  now = Date.now(),
  halfLife = halflifeMs(),
  baseTime?: number,
): number {
  const anchor = Math.max(baseTime ?? r.updated_at, r.last_used_at ?? 0)
  const recency = Math.pow(0.5, Math.max(0, now - anchor) / halfLife)
  const frequency = 1 + Math.log1p(r.use_count ?? 0)
  const importance = Math.max(0, r.confidence ?? 1)
  return recency * frequency * importance
}

/** Rank rows by strength (descending), attaching the computed score to each row. The SQL
 *  ORDER BY stays as the deterministic base so the flag-off path is byte-identical to the
 *  pre-reinforcement behavior. Stable sort: equal-strength rows keep the SQL order. */
function rankByStrength(rows: MemoryRow[], now: number, eventTime?: (r: MemoryRow) => number): MemoryRow[] {
  if (!reinforceOn() || rows.length === 0) return rows
  const hl = halflifeMs()
  for (const r of rows) r.strength = memoryStrength(r, now, hl, eventTime?.(r))
  return rows.sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))
}

export class MemoryRepo {
  constructor(private readonly db: Database) {}

  /** The current (live) memory for a subject_key, if any. "Live" = latest, not forgotten.
   *  When `scope` is provided the match is RESTRICTED to virtual_record_ids the writer can SEE -
   *  the same ACL gate the read path uses - so consolidation/contradiction only ever supersede a
   *  belief the writer can actually see. Without it (undefined) the search is global (legacy;
   *  direct/test call sites). An explicit EMPTY scope means "nothing visible" → no match.
   *
   *  SCALE-INVARIANT: a subject_key has only a HANDFUL of live rows (at most one per distinct
   *  ACL scope currently asserting it), so we fetch those (indexed by subject_key,is_latest) and
   *  membership-test them in JS - O(live-rows-for-subject), NOT O(accessible-set). This is what
   *  turns ingest from O(N²) (an IN-list of the whole ACL per triple) into ~O(N). */
  latestBySubject(subjectKey: string, scope?: ScopeSet): MemoryRow | undefined {
    if (scope && scope.size === 0) return undefined
    const rows = this.db
      .query(
        "SELECT * FROM memories WHERE subject_key = ? AND is_latest = 1 AND is_forgotten = 0 ORDER BY version DESC LIMIT 256",
      )
      .all(subjectKey) as MemoryRow[]
    if (!scope) return rows[0]
    for (const r of rows) if (scope.has(r.virtual_record_id)) return r
    return undefined
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

  /** Usage reinforcement: mark memories as just-recalled-and-used (bump frequency, reset
   *  the usage clock). Caller = the retrieval layer, with the ids it actually RETURNED -
   *  not everything it scanned - so only surfaced memories strengthen. Deliberately does
   *  NOT touch updated_at: belief time (the version chain) and usage time are separate
   *  axes, and reinforcement must never look like a belief revision. Returns rows affected. */
  reinforce(ids: string[], now = Date.now()): number {
    if (ids.length === 0) return 0
    const res = this.db
      .query(`UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id IN (${ph(ids.length)})`)
      .run(now, ...ids)
    return Number(res.changes)
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
   *  by construction (an inaccessible vid is never in the IN-list). Ranked by usage
   *  strength (recency x frequency x importance; see memoryStrength) so a memory that
   *  keeps getting used outranks an equally-current one nobody touches. */
  recall(accessibleVids: string[], now = Date.now()): MemoryRow[] {
    if (accessibleVids.length === 0) return []
    const rows = this.db
      .query(
        `SELECT * FROM memories
         WHERE virtual_record_id IN (${ph(accessibleVids.length)})
           AND kind = 'semantic' AND is_latest = 1 AND is_forgotten = 0
           AND (forget_after IS NULL OR forget_after > ?)
         ORDER BY updated_at DESC`,
      )
      .all(...accessibleVids, now) as MemoryRow[]
    return rankByStrength(rows, now)
  }

  /** Episodic memories the caller may see (time-anchored experiences), strongest first
   *  (EVENT-time recency x usage frequency x importance - an episode anchors on when it
   *  HAPPENED, not when it was ingested). Not versioned/deduped like facts - each episode
   *  is a distinct experience; the caller further ranks by relevance x recency (it holds
   *  the query embedding). ACL-scoped like recall. */
  recallEpisodes(accessibleVids: string[], now = Date.now()): MemoryRow[] {
    if (accessibleVids.length === 0) return []
    const rows = this.db
      .query(
        `SELECT * FROM memories
         WHERE virtual_record_id IN (${ph(accessibleVids.length)})
           AND kind = 'episodic' AND is_forgotten = 0
           AND (forget_after IS NULL OR forget_after > ?)
         ORDER BY COALESCE(occurred_at, created_at) DESC`,
      )
      .all(...accessibleVids, now) as MemoryRow[]
    return rankByStrength(rows, now, (r) => r.occurred_at ?? r.created_at)
  }

  /** Procedural memories the caller may see (learned how-tos / preferences), current
   *  only, strongest first - a how-to the agent keeps reaching for outranks a stale one. */
  recallProcedures(accessibleVids: string[], now = Date.now()): MemoryRow[] {
    if (accessibleVids.length === 0) return []
    const rows = this.db
      .query(
        `SELECT * FROM memories
         WHERE virtual_record_id IN (${ph(accessibleVids.length)})
           AND kind = 'procedural' AND is_latest = 1 AND is_forgotten = 0
           AND (forget_after IS NULL OR forget_after > ?)
         ORDER BY updated_at DESC`,
      )
      .all(...accessibleVids, now) as MemoryRow[]
    return rankByStrength(rows, now)
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
