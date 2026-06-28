// Knowledge-graph assembly + GraphRAG expansion over the ACL-filtered record set.
//
// SECURITY INVARIANT (provenance leak-guard): in `getKnowledgeGraph`, a relation
// surfaces ONLY if a record the user may access ASSERTED it (provenance ∩
// accessible ≠ ∅). Endpoint visibility is NOT enough - two visible entities can
// still have a relationship stated only in a record the user can't see. Fail
// closed: no provenance match ⇒ hidden. Preserve this exactly.

import type { SqlAccess } from "./sql-access"

/** Record names (within the accessible set) that mention any of the given entities. */
export function recordsMentioning(sql: SqlAccess, entityIds: string[], accessibleRecordIds: string[]): string[] {
  if (entityIds.length === 0 || accessibleRecordIds.length === 0) return []
  const rows = sql.rows<{ data: string }>(
    `SELECT DISTINCT n.data AS data
       FROM edges m JOIN nodes n ON n.id = m.src AND n.coll = 'records'
       WHERE m.label = 'mentions' AND m.dst IN (${sql.ph(entityIds.length)}) AND m.src IN (${sql.ph(accessibleRecordIds.length)})`,
    [...entityIds, ...accessibleRecordIds],
  )
  return rows.map((r) => (JSON.parse(r.data) as { recordName?: string }).recordName ?? "").filter(Boolean)
}

/** GraphRAG hop: records connected to the seeds through shared/related concepts.
 *  seed records → their entities → relates_to neighbors → other records that
 *  mention those neighbors. Constrained to `accessibleRecordIds` (ACL-safe) and
 *  excluding the seeds themselves. */
export function getRelatedRecordIds(
  sql: SqlAccess,
  seedRecordIds: string[],
  accessibleRecordIds: string[],
  limit = 5,
): string[] {
  if (seedRecordIds.length === 0 || accessibleRecordIds.length === 0) return []
  const seedEnts = sql
    .rows<{ dst: string }>(
      `SELECT DISTINCT dst FROM edges WHERE label = 'mentions' AND src IN (${sql.ph(seedRecordIds.length)})`,
      seedRecordIds,
    )
    .map((r) => r.dst)
  if (seedEnts.length === 0) return []
  const ep = sql.ph(seedEnts.length)
  const neighbors = new Set<string>(seedEnts)
  // Follow entity→entity relation edges of ANY predicate (exclude structural
  // labels), LIVE edges only - superseded facts don't drive current expansion.
  for (const r of sql.rows<{ e: string }>(
    `SELECT dst AS e FROM edges WHERE label NOT IN ('mentions','permissions','belongsTo','inheritPermissions') AND expired_at IS NULL AND src IN (${ep})
       UNION SELECT src AS e FROM edges WHERE label NOT IN ('mentions','permissions','belongsTo','inheritPermissions') AND expired_at IS NULL AND dst IN (${ep})`,
    [...seedEnts, ...seedEnts],
  ))
    neighbors.add(r.e)

  const nb = [...neighbors]
  const seeds = new Set(seedRecordIds)
  const acc = new Set(accessibleRecordIds)
  const related = sql
    .rows<{ src: string }>(
      `SELECT src, COUNT(*) c FROM edges
       WHERE label = 'mentions' AND dst IN (${sql.ph(nb.length)})
       GROUP BY src ORDER BY c DESC`,
      nb,
    )
    .map((r) => r.src)
    .filter((id) => acc.has(id) && !seeds.has(id))
  return related.slice(0, limit)
}

/** The knowledge graph the given (already ACL-filtered) records expose:
 *  entities those records mention + relationships among them. ACL-safe because
 *  the caller passes only recordIds the user may access. */
export function getKnowledgeGraph(
  sql: SqlAccess,
  recordIds: string[],
): {
  entities: Array<{ id: string; label: string; type: string }>
  relations: Array<{ from: string; to: string; type: string; weight: number }>
} {
  if (recordIds.length === 0) return { entities: [], relations: [] }
  const ph = sql.ph(recordIds.length)
  const ents = sql
    .rows<{ id: string; data: string }>(
      `SELECT DISTINCT e.id AS id, e.data AS data
       FROM edges m JOIN nodes e ON e.id = m.dst AND e.coll = 'entities'
       WHERE m.label = 'mentions' AND m.src IN (${ph})`,
      recordIds,
    )
    .map((r) => {
      const d = JSON.parse(r.data) as { label?: string; type?: string }
      return { id: r.id, label: d.label ?? r.id, type: d.type ?? "CONCEPT" }
    })
  const ids = new Set(ents.map((e) => e.id))
  const accessible = new Set(recordIds)
  // Typed relations: entity→entity edges of any predicate (exclude structural labels).
  // Only LIVE edges (expired_at IS NULL) - superseded facts stay in history but never
  // surface as current. PERMISSION-FILTERED PER EDGE: an edge surfaces only if a record
  // the user may access ASSERTED it (provenance ∩ accessible ≠ ∅). Endpoint visibility
  // is NOT enough - two visible entities can still have a relationship stated only in a
  // record the user can't see (fail-closed: no provenance match ⇒ hidden).
  const relations = sql
    .rows<{ src: string; dst: string; label: string; weight: number; provenance: string }>(
      `SELECT DISTINCT src, dst, label, weight, provenance FROM edges
       WHERE label NOT IN ('mentions','permissions','belongsTo','inheritPermissions') AND expired_at IS NULL
       ORDER BY weight DESC`,
      [],
    )
    .filter((r) => ids.has(r.src) && ids.has(r.dst) && (JSON.parse(r.provenance || "[]") as string[]).some((p) => accessible.has(p)))
    .map((r) => ({ from: r.src, to: r.dst, type: r.label, weight: r.weight }))
  return { entities: ents, relations }
}
