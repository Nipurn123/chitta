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
 *  mention those neighbors. Constrained to the `accessible` record-id set (ACL-safe) and
 *  excluding the seeds themselves.
 *
 *  SCALE-INVARIANT by default (O(1) in graph size): the bounded path caps every step to a
 *  fixed budget, so query latency stays flat as the graph grows to millions of edges. Set
 *  CONTEXT_GRAPH_BOUNDED=0 for the exact legacy (unbounded, O(density)) behavior - kept for
 *  the A/B measurement and instant rollback. */
export function getRelatedRecordIds(
  sql: SqlAccess,
  seedRecordIds: string[],
  accessible: ReadonlySet<string>,
  limit = 5,
): string[] {
  if (seedRecordIds.length === 0 || accessible.size === 0) return []
  return /^(0|false|off)$/i.test(process.env.CONTEXT_GRAPH_BOUNDED ?? "1")
    ? relatedUnbounded(sql, seedRecordIds, accessible, limit)
    : relatedBounded(sql, seedRecordIds, accessible, limit)
}

const REL_EXCL = "('mentions','permissions','belongsTo','inheritPermissions')"

// SCALE-INVARIANT graph hop (O(1) in graph size). A HUB entity (mentioned by more than `hub`
// records) bridges to everything - it's noise, not signal, and expanding through it is exactly
// what made this stage O(density). So: (1) fan out ONLY from SPECIFIC (non-hub) seed entities,
// (2) keep the MAXNB most SPECIFIC (rarest, most discriminating) neighbors, (3) scan only their
// mentions. Every step is bounded to a fixed budget independent of N. On real (power-law) graphs
// this drops only the low-relevance long tail - measured recall holds (relevance concentrates in
// the specific neighborhood). Hub detection uses a LIMIT (hub+1) count, so testing an entity
// costs O(hub), never O(hub-size) - no precomputed degree, no schema change.
function relatedBounded(sql: SqlAccess, seedRecordIds: string[], acc: ReadonlySet<string>, limit: number): string[] {
  const HUB = Number(process.env.CONTEXT_GRAPH_HUB ?? 60)
  const MAXNB = Number(process.env.CONTEXT_GRAPH_MAXNB ?? 64)
  const SCAN = Number(process.env.CONTEXT_GRAPH_NB_SCAN ?? 512)

  // Degree, counted only up to HUB+1 - the scan stops early, so a hub costs O(hub), not O(size).
  // Returns the TRUE degree when ≤ HUB (usable to rank rarest), else hub+1 (the "is-a-hub" flag).
  const degCapped = (entId: string): number =>
    sql.rows<{ c: number }>(
      `SELECT COUNT(*) c FROM (SELECT 1 FROM edges WHERE label = 'mentions' AND dst = ? LIMIT ${HUB + 1})`,
      [entId],
    )[0]?.c ?? 0

  // seed entities (bounded), then keep only the SPECIFIC ones - a hub seed would fan out to the
  // whole graph, so it never seeds expansion.
  const seedEnts = sql
    .rows<{ dst: string }>(
      `SELECT DISTINCT dst FROM edges WHERE label = 'mentions' AND src IN (${sql.ph(seedRecordIds.length)}) LIMIT 256`,
      seedRecordIds,
    )
    .map((r) => r.dst)
    .filter((e) => degCapped(e) <= HUB)
  if (seedEnts.length === 0) return []

  const ep = sql.ph(seedEnts.length)
  // typed-edge neighbors of the specific seeds (LIVE edges only); materialization capped at SCAN.
  const rawNb = sql
    .rows<{ e: string }>(
      `SELECT e FROM (
          SELECT dst AS e FROM edges WHERE label NOT IN ${REL_EXCL} AND expired_at IS NULL AND src IN (${ep})
          UNION SELECT src AS e FROM edges WHERE label NOT IN ${REL_EXCL} AND expired_at IS NULL AND dst IN (${ep})
       ) LIMIT ${SCAN}`,
      [...seedEnts, ...seedEnts],
    )
    .map((r) => r.e)

  // rank neighbors by specificity (rarest first), drop hubs, cap to MAXNB → fixed-size scan set.
  const nb = [...new Set([...seedEnts, ...rawNb])]
    .map((id) => ({ id, deg: degCapped(id) }))
    .filter((x) => x.deg > 0 && x.deg <= HUB)
    .sort((a, b) => a.deg - b.deg)
    .slice(0, MAXNB)
    .map((x) => x.id)
  if (nb.length === 0) return []

  const seeds = new Set(seedRecordIds)
  // records mentioning the specific neighbors, ranked by how many they share. Bounded: ≤ MAXNB
  // neighbors × ≤ HUB mentions each = a fixed scan, regardless of total graph size.
  return sql
    .rows<{ src: string }>(
      `SELECT src, COUNT(*) c FROM edges
       WHERE label = 'mentions' AND dst IN (${sql.ph(nb.length)})
       GROUP BY src ORDER BY c DESC LIMIT 256`,
      nb,
    )
    .map((r) => r.src)
    .filter((id) => acc.has(id) && !seeds.has(id))
    .slice(0, limit)
}

// LEGACY unbounded hop (O(density)) - the exact prior behavior, retained for the A/B and rollback.
function relatedUnbounded(sql: SqlAccess, seedRecordIds: string[], acc: ReadonlySet<string>, limit: number): string[] {
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
    `SELECT dst AS e FROM edges WHERE label NOT IN ${REL_EXCL} AND expired_at IS NULL AND src IN (${ep})
       UNION SELECT src AS e FROM edges WHERE label NOT IN ${REL_EXCL} AND expired_at IS NULL AND dst IN (${ep})`,
    [...seedEnts, ...seedEnts],
  ))
    neighbors.add(r.e)

  const nb = [...neighbors]
  const seeds = new Set(seedRecordIds)
  return sql
    .rows<{ src: string }>(
      `SELECT src, COUNT(*) c FROM edges
       WHERE label = 'mentions' AND dst IN (${sql.ph(nb.length)})
       GROUP BY src ORDER BY c DESC`,
      nb,
    )
    .map((r) => r.src)
    .filter((id) => acc.has(id) && !seeds.has(id))
    .slice(0, limit)
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
