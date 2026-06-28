// ACL permission paths - the Arango-AQL traversal ported to SQL over the generic
// node/edge tables. These eight-path-collapsed-to-five helpers are the access
// moat; the provider unions their results and dedupes first-writer-wins.
//
//   • principals    = the user + every group/role/org/team they belong to or are
//                     permissioned to (one hop).
//   • directRecords = records permissioned to any principal.
//   • recordGroups  = record-groups permissioned to any principal, then both:
//       - inheritedRecords (recursive descent over inheritPermissions), and
//       - kbRecords (records that belong to those groups, origin=UPLOAD).
//   • anyoneRecords = org-wide shared records.
// Same invariant as the Arango port; only the query language differs.

import type { UserDoc } from "../../types"
import { COMPLETED, type Pair, type SqlAccess } from "./sql-access"

export function userRow(sql: SqlAccess, userId: string): (UserDoc & { id: string }) | null {
  const r = sql.rows<{ id: string; data: string }>(
    "SELECT id, data FROM nodes WHERE coll = 'users' AND json_extract(data, '$.userId') = ? LIMIT 1",
    [userId],
  )[0]
  if (!r) return null
  return { ...(JSON.parse(r.data) as UserDoc), id: r.id, _key: r.id }
}

export function principalIds(sql: SqlAccess, userId: string): string[] {
  const belongs = sql.rows<{ dst: string }>("SELECT dst FROM edges WHERE src = ? AND label = 'belongsTo'", [userId])
  const permPrincipals = sql.rows<{ dst: string }>(
    `SELECT e.dst AS dst FROM edges e JOIN nodes n ON n.id = e.dst
       WHERE e.src = ? AND e.label = 'permissions'
         AND n.coll IN ('groups','roles','organizations','teams')`,
    [userId],
  )
  return [...new Set([userId, ...belongs.map((r) => r.dst), ...permPrincipals.map((r) => r.dst)])]
}

export function recordsPermissionedTo(sql: SqlAccess, principals: string[], apps?: string[]): Pair[] {
  if (principals.length === 0) return []
  const appClause = apps?.length ? ` AND json_extract(r.data,'$.connectorId') IN (${sql.ph(apps.length)})` : ""
  return sql.rows<Pair>(
    `SELECT r.id AS rid, json_extract(r.data,'$.virtualRecordId') AS vid
       FROM edges e JOIN nodes r ON r.id = e.dst AND r.coll = 'records'
       WHERE e.label = 'permissions' AND e.src IN (${sql.ph(principals.length)})
         AND json_extract(r.data,'$.indexingStatus') = ?${appClause}`,
    [...principals, COMPLETED, ...(apps ?? [])],
  )
}

export function recordGroupsPermissionedTo(sql: SqlAccess, principals: string[], kb?: string[]): string[] {
  if (principals.length === 0) return []
  const kbClause = kb?.length ? ` AND n.id IN (${sql.ph(kb.length)})` : ""
  return sql
    .rows<{ id: string }>(
      `SELECT DISTINCT n.id AS id FROM edges e JOIN nodes n ON n.id = e.dst AND n.coll = 'recordGroups'
       WHERE e.label = 'permissions' AND e.src IN (${sql.ph(principals.length)})${kbClause}`,
      [...principals, ...(kb ?? [])],
    )
    .map((r) => r.id)
}

export function recordsInheritingFrom(sql: SqlAccess, recordGroups: string[]): Pair[] {
  if (recordGroups.length === 0) return []
  return sql.rows<Pair>(
    `WITH RECURSIVE descend(id) AS (
         SELECT src FROM edges WHERE label = 'inheritPermissions' AND dst IN (${sql.ph(recordGroups.length)})
         UNION
         SELECT e.src FROM edges e JOIN descend d ON e.dst = d.id WHERE e.label = 'inheritPermissions'
       )
       SELECT r.id AS rid, json_extract(r.data,'$.virtualRecordId') AS vid
       FROM nodes r JOIN descend ON r.id = descend.id
       WHERE r.coll = 'records' AND json_extract(r.data,'$.indexingStatus') = ?`,
    [...recordGroups, COMPLETED],
  )
}

export function kbRecords(sql: SqlAccess, recordGroups: string[]): Pair[] {
  if (recordGroups.length === 0) return []
  return sql.rows<Pair>(
    `SELECT r.id AS rid, json_extract(r.data,'$.virtualRecordId') AS vid
       FROM edges e JOIN nodes r ON r.id = e.src AND r.coll = 'records'
       WHERE e.label = 'belongsTo' AND e.dst IN (${sql.ph(recordGroups.length)})
         AND json_extract(r.data,'$.origin') = 'UPLOAD'
         AND json_extract(r.data,'$.indexingStatus') = ?`,
    [...recordGroups, COMPLETED],
  )
}

export function anyoneRecords(sql: SqlAccess, orgId: string): Pair[] {
  return sql.rows<Pair>(
    `SELECT r.id AS rid, json_extract(r.data,'$.virtualRecordId') AS vid
       FROM nodes a JOIN nodes r ON r.id = json_extract(a.data,'$.file_key') AND r.coll = 'records'
       WHERE a.coll = 'anyone' AND json_extract(a.data,'$.organization') = ?
         AND json_extract(r.data,'$.indexingStatus') = ?`,
    [orgId, COMPLETED],
  )
}
