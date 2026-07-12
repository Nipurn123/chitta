// Memory salience / decay ops. Pure structural extraction from sqlite-store.ts -
// identical SQL, identical behavior.

import { Database } from "bun:sqlite"
import { ph } from "./schema"

// Memory salience (Generative-Agents / ACT-R): per-record access recency, frequency,
// and importance - used to gently re-weight retrieval so fresh/important/often-used
// memories surface over stale ones. NEVER deletes; only dampens retrieval strength.
export function recordSalience(
  db: Database,
  recordIds: string[],
): Map<string, { lastAccessedAt: number; accessCount: number; importance: number }> {
  const out = new Map<string, { lastAccessedAt: number; accessCount: number; importance: number }>()
  if (recordIds.length === 0) return out
  const rows = db
    .query(
      `SELECT id,
              COALESCE(json_extract(data,'$.lastAccessedAt'), json_extract(data,'$.createdAt'), 0) la,
              COALESCE(json_extract(data,'$.accessCount'), 0) ac,
              COALESCE(json_extract(data,'$.importance'), 1) imp
       FROM nodes WHERE coll = 'records' AND id IN (${ph(recordIds.length)})`,
    )
    .all(...recordIds) as Array<{ id: string; la: number; ac: number; imp: number }>
  for (const r of rows) out.set(r.id, { lastAccessedAt: r.la, accessCount: r.ac, importance: r.imp })
  return out
}

/** Mark records as just-accessed (bump recency + frequency) - called on retrieval. */
export function touchRecords(db: Database, recordIds: string[]): void {
  const now = Date.now()
  const stmt = db.query(
    `UPDATE nodes SET data = json_set(json_set(data,'$.lastAccessedAt', ?), '$.accessCount',
      COALESCE(json_extract(data,'$.accessCount'),0) + 1) WHERE id = ? AND coll = 'records'`,
  )
  for (const id of recordIds) stmt.run(now, id)
}
