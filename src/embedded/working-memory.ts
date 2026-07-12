// Working memory - the session-scoped scratchpad tier in front of long-term memory.
// Mirrors how humans consolidate: within a session everything lands here cheaply (no
// embedding, no versioning - just a row), and at session end consolidate() promotes
// the SALIENT few into the long-term memories table and drops the rest. Most chatter
// is forgotten; what survives is what the session kept coming back to.
//
// Salience is DETERMINISTIC (no LLM) - an item is worth keeping when any of:
//   • repeated  - the same content was noted again within the session (repeat_count >= 2),
//   • important - the caller explicitly flagged it ({ important: true }),
//   • referenced - it was used/cited multiple times after being noted (ref_count >= 2).
//
// Promotion goes through consolidateFact - the same belief-revision path ingest uses -
// so a promoted item dedupes against itself across sessions (re-promoting identical
// content refreshes recency instead of duplicating) and inherits the target record's
// ACL via virtual_record_id. Embeddings are computed at PROMOTION time only, so the
// 90% that gets dropped never costs an embed (encode cheaply, consolidate expensively).
//
// Stale sessions auto-expire: any item untouched for CONTEXT_WM_TTL_HOURS (default 24)
// is hard-DELETED on the next operation - working memory is a buffer, not a record, so
// unlike long-term forgetting there is no soft-delete and no history.

import { Database } from "bun:sqlite"
import type { EmbeddingProvider } from "../provider"
import { MemoryRepo } from "./store/memories"
import { migrateWorkingMemory } from "./store/schema"
import { consolidateFact } from "./memory/consolidate"
import { sanitizeText } from "../security/sanitize"

export interface WorkingItemRow {
  id: string
  session_id: string
  content: string
  important: number
  repeat_count: number
  ref_count: number
  created_at: number
  last_seen_at: number
}

/** Where promoted items land in long-term memory: the ACL anchor (virtual_record_id -
 *  promoted memories are recallable exactly by whoever can see that record), plus the
 *  usual provenance/TTL knobs the consolidation path takes. */
export interface ConsolidateTarget {
  orgId: string
  virtualRecordId: string
  /** Provenance for the promoted rows; defaults to `wm:<sessionId>`. */
  sourceRecordId?: string
  /** TTL (ms from now) for the promoted memories; omitted = no auto-expiry. */
  ttlMs?: number
}

function wmTtlMs(): number {
  return Math.max(1, Number(process.env.CONTEXT_WM_TTL_HOURS ?? 24)) * 3_600_000
}

function newId(): string {
  return `wm:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

/** Collapse whitespace + strip injection so "the  same   note" dedupes with "the same note". */
function normalize(content: string): string {
  return sanitizeText(content).trim().replace(/\s+/g, " ")
}

/** FNV-1a over the lowercased content - a stable subject_key for promotion, so the same
 *  working-memory item promoted from two sessions folds into ONE long-term memory chain. */
function contentHash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}

function isSalient(it: WorkingItemRow): boolean {
  return it.important === 1 || it.repeat_count >= 2 || it.ref_count >= 2
}

export class WorkingMemory {
  private readonly repo: MemoryRepo

  /** Runs over the SAME SQLite handle as the rest of the store (e.g. `ctx.store.db`) -
   *  one file stays the whole memory. Table creation is idempotent, so constructing over
   *  an already-migrated store (or a bare Database) both work. */
  constructor(
    private readonly db: Database,
    private readonly embeddings: EmbeddingProvider,
  ) {
    migrateWorkingMemory(db)
    this.repo = new MemoryRepo(db)
  }

  /** Drop an item into the session's working memory. Re-noting content the session already
   *  holds bumps repeat_count instead of duplicating - that repetition IS the salience
   *  signal consolidation reads. Returns the item id ("" when there is nothing to store). */
  note(sessionId: string, content: string, opts: { important?: boolean } = {}): string {
    this.expireStale()
    const text = normalize(content)
    if (!sessionId || !text) return ""
    const now = Date.now()
    const existing = this.db
      .query("SELECT id FROM working_memory WHERE session_id = ? AND lower(content) = lower(?) LIMIT 1")
      .get(sessionId, text) as { id: string } | null
    if (existing) {
      this.db
        .query("UPDATE working_memory SET repeat_count = repeat_count + 1, last_seen_at = ?, important = MAX(important, ?) WHERE id = ?")
        .run(now, opts.important ? 1 : 0, existing.id)
      return existing.id
    }
    const id = newId()
    this.db
      .query(
        `INSERT INTO working_memory (id, session_id, content, important, repeat_count, ref_count, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, 1, 0, ?, ?)`,
      )
      .run(id, sessionId, text, opts.important ? 1 : 0, now, now)
    return id
  }

  /** Record that an item was USED again within the session (cited, acted on, re-read) -
   *  the third salience signal. Accepts the item id or its content. Returns whether a
   *  live item matched. */
  markReferenced(sessionId: string, idOrContent: string): boolean {
    const res = this.db
      .query(
        "UPDATE working_memory SET ref_count = ref_count + 1, last_seen_at = ? WHERE session_id = ? AND (id = ? OR lower(content) = lower(?))",
      )
      .run(Date.now(), sessionId, idOrContent, normalize(idOrContent))
    return Number(res.changes) > 0
  }

  /** The session's live items, oldest first. Sweeps stale sessions first, so a session
   *  past its TTL reads as empty (auto-expiry is lazy, like the memories TTL sweep). */
  items(sessionId: string): WorkingItemRow[] {
    this.expireStale()
    return this.db
      .query("SELECT * FROM working_memory WHERE session_id = ? ORDER BY created_at ASC")
      .all(sessionId) as WorkingItemRow[]
  }

  /** Consolidate the session: promote every salient item (repeated / important /
   *  referenced) into long-term memory, then drop the WHOLE session - promoted or not,
   *  working memory empties, exactly like sleep clears the day's buffer. A session
   *  already past its TTL was forgotten wholesale, so it promotes nothing. Returns the
   *  promoted texts (deduped re-promotions included - the info survives either way)
   *  and how many items were dropped as noise. */
  async consolidate(sessionId: string, target: ConsolidateTarget): Promise<{ promoted: string[]; dropped: number }> {
    const all = this.items(sessionId) // sweeps stale sessions first
    const keep = all.filter(isSalient)
    const promoted: string[] = []
    for (const item of keep) {
      // Key on (vid | content-hash): dedupe is per ACL anchor, so one user's promotion
      // can never touch (or anchor under) another user's identical-but-private note.
      const subjectKey = `wm|${target.virtualRecordId}|${contentHash(item.content.toLowerCase())}`
      await consolidateFact(
        this.repo,
        this.embeddings,
        { subjectKey, memory: item.content, functional: false, isStatic: false },
        {
          orgId: target.orgId,
          virtualRecordId: target.virtualRecordId,
          sourceRecordId: target.sourceRecordId ?? `wm:${sessionId}`,
          ttlMs: target.ttlMs,
        },
      )
      promoted.push(item.content)
    }
    this.db.query("DELETE FROM working_memory WHERE session_id = ?").run(sessionId)
    return { promoted, dropped: all.length - keep.length }
  }

  /** Hard-delete every item not touched within the TTL window (whole-session decay -
   *  an abandoned session vanishes without a trace). Called lazily by note()/items()/
   *  consolidate(); safe to call on a schedule too. Returns rows deleted. */
  expireStale(now = Date.now()): number {
    const res = this.db.query("DELETE FROM working_memory WHERE last_seen_at < ?").run(now - wmTtlMs())
    return Number(res.changes)
  }

  /** Live item/session counts - for stats/discovery surfaces. */
  counts(): { items: number; sessions: number } {
    const items = (this.db.query("SELECT count(*) c FROM working_memory").get() as { c: number }).c
    const sessions = (this.db.query("SELECT count(DISTINCT session_id) c FROM working_memory").get() as { c: number }).c
    return { items, sessions }
  }
}
