// Graph vertex/edge CRUD + provenance + supersession. Pure structural extraction
// from sqlite-store.ts - identical SQL, identical behavior.

import { Database } from "bun:sqlite"
import type { Json } from "../sqlite-store"

export function addNode(db: Database, id: string, coll: string, data: Json = {}): void {
  db.query("INSERT OR REPLACE INTO nodes (id, coll, data) VALUES (?, ?, ?)").run(id, coll, JSON.stringify(data))
}

// Merge-on-upsert (LightRAG): one row per (src,dst,label). Re-asserting an edge
// ACCUMULATES weight, refreshes its validity (revives a previously superseded
// edge), and unions provenance - the graph gets denser per write, never duplicated.
export function addEdge(
  db: Database,
  src: string,
  dst: string,
  label: string,
  opts: { weight?: number; validAt?: number; recordId?: string; confidence?: number } = {},
): void {
  const now = Date.now()
  db
    .query(
      `INSERT INTO edges (src, dst, label, weight, created_at, valid_at, invalid_at, expired_at, provenance, confidence)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, '[]', ?)
       ON CONFLICT(src, dst, label) DO UPDATE SET
         weight = weight + excluded.weight,
         expired_at = NULL,
         invalid_at = NULL,
         valid_at = COALESCE(edges.valid_at, excluded.valid_at),
         confidence = MAX(edges.confidence, excluded.confidence)`,
    )
    .run(src, dst, label, opts.weight ?? 1, now, opts.validAt ?? null, opts.confidence ?? 1)
  if (opts.recordId) addProvenance(db, src, dst, label, opts.recordId)
}

// Union a source record id into an edge's provenance list (which records asserted it).
function addProvenance(db: Database, src: string, dst: string, label: string, recordId: string): void {
  const row = db.query("SELECT provenance FROM edges WHERE src = ? AND dst = ? AND label = ?").get(src, dst, label) as
    | { provenance: string }
    | undefined
  if (!row) return
  const set = new Set<string>(JSON.parse(row.provenance) as string[])
  if (set.has(recordId)) return
  set.add(recordId)
  db.query("UPDATE edges SET provenance = ? WHERE src = ? AND dst = ? AND label = ?").run(JSON.stringify([...set]), src, dst, label)
}

// Source-keyed replace-on-reingest (Graphify build_merge): before re-ingesting a
// record, drop everything IT contributed so facts removed from the source get
// garbage-collected (an entity-id-keyed upsert alone would orphan them forever).
// Removes the record's `mentions` edges, and strips the record from every concept
// edge's provenance - deleting the edge if no other record still asserts it, else
// lowering its weight to the surviving source count.
export function clearRecordContributions(db: Database, recordId: string): void {
  db.query("DELETE FROM edges WHERE src = ? AND label = 'mentions'").run(recordId)
  const rows = db
    .query("SELECT src, dst, label, provenance FROM edges WHERE provenance LIKE ?")
    .all(`%${JSON.stringify(recordId).slice(1, -1)}%`) as Array<{ src: string; dst: string; label: string; provenance: string }>
  for (const r of rows) {
    const prov = (JSON.parse(r.provenance) as string[]).filter((p) => p !== recordId)
    if (prov.length === (JSON.parse(r.provenance) as string[]).length) continue // not actually this record
    if (prov.length === 0) {
      db.query("DELETE FROM edges WHERE src = ? AND dst = ? AND label = ?").run(r.src, r.dst, r.label)
    } else {
      db
        .query("UPDATE edges SET provenance = ?, weight = ? WHERE src = ? AND dst = ? AND label = ?")
        .run(JSON.stringify(prov), prov.length, r.src, r.dst, r.label)
    }
  }
}

// Non-destructive supersession (Graphiti): close the validity interval on every
// LIVE edge from `src` with this `label` whose target ISN'T `keepDst`. Used for a
// FUNCTIONAL relation (single-valued: lives_in, works_at) when a newer fact arrives.
// The old edge stays in the table with invalid_at/expired_at set - history intact.
export function supersedeEdge(db: Database, src: string, label: string, keepDst: string, atTime = Date.now()): number {
  const res = db
    .query(
      `UPDATE edges SET invalid_at = ?, expired_at = ?
       WHERE src = ? AND label = ? AND dst != ? AND expired_at IS NULL`,
    )
    .run(atTime, Date.now(), src, label, keepDst)
  return Number(res.changes)
}

// Backfill provenance for LEGACY concept edges that predate provenance tracking
// (migrated/older data has provenance '[]'). With per-edge ACL now fail-closed, an
// un-provenanced edge would be hidden from everyone - so attribute each to the
// records that mention BOTH of its endpoints (where the relationship was extracted),
// restoring it to the correct permission scope. Returns the number repaired.
export function backfillEdgeProvenance(db: Database): number {
  const edges = db
    .query(
      `SELECT src, dst, label FROM edges
       WHERE provenance = '[]' AND label NOT IN ('mentions','permissions','belongsTo','inheritPermissions')`,
    )
    .all() as Array<{ src: string; dst: string; label: string }>
  const recordsMentioningBoth = db.query(
    `SELECT m1.src AS r FROM edges m1 JOIN edges m2 ON m1.src = m2.src
     WHERE m1.label = 'mentions' AND m2.label = 'mentions' AND m1.dst = ? AND m2.dst = ?`,
  )
  let repaired = 0
  for (const e of edges) {
    const recs = [...new Set((recordsMentioningBoth.all(e.src, e.dst) as Array<{ r: string }>).map((x) => x.r))]
    if (recs.length) {
      db.query("UPDATE edges SET provenance = ? WHERE src = ? AND dst = ? AND label = ?").run(JSON.stringify(recs), e.src, e.dst, e.label)
      repaired++
    }
  }
  return repaired
}
