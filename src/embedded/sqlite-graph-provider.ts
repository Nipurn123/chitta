// GraphProvider over bun:sqlite - the ACL traversal ported from AQL to SQL.
//
// The Arango version ran eight permission paths; here they collapse to the same
// access semantics expressed over the generic node/edge tables:
//   • principals = the user + every group/role/org/team they belong to or are
//     permissioned to (one hop).
//   • directRecords = records permissioned to any principal.
//   • recordGroups  = record-groups permissioned to any principal, then both:
//       - inheritedRecords (recursive descent over inheritPermissions), and
//       - kbRecords (records that belong to those groups, origin=UPLOAD).
//   • anyoneRecords = org-wide shared records.
// All unioned, then deduped first-writer-wins → { virtualRecordId: recordId }.
// Same invariant as the Arango port; only the query language differs.
//
// This file is the ORCHESTRATOR: it owns the bun:sqlite handle and the row/
// placeholder helpers, and delegates the permission-path SQL to ./graph/acl-paths
// and the entity/edge assembly to ./graph/knowledge-graph (where the per-edge
// provenance leak-guard lives).

import type { GraphProvider } from "../provider"
import type { AccessibleMap, RecordDoc, RetrievalFilters, UserDoc } from "../types"
import * as acl from "./graph/acl-paths"
import * as kg from "./graph/knowledge-graph"
import type { Pair, SqlAccess } from "./graph/sql-access"
import type { SqliteStore } from "./sqlite-store"

export class SqliteGraphProvider implements GraphProvider {
  constructor(private readonly store: SqliteStore) {}
  private get db() {
    return this.store.db
  }
  private rows<T = any>(sql: string, params: unknown[]): T[] {
    return this.db.query(sql).all(...(params as any[])) as T[]
  }
  private ph(n: number): string {
    return Array.from({ length: n }, () => "?").join(",")
  }
  // The SQL-access seam handed to the decomposed query modules.
  private get sql(): SqlAccess {
    return { rows: this.rows.bind(this), ph: this.ph.bind(this) }
  }

  async getAccessibleVirtualRecordIds(args: {
    userId: string
    orgId: string
    filters?: RetrievalFilters
  }): Promise<AccessibleMap> {
    const user = acl.userRow(this.sql, args.userId)
    if (!user) return {} // deny by default
    const f = args.filters ?? {}

    const principals = acl.principalIds(this.sql, user.id)
    const recordGroups = acl.recordGroupsPermissionedTo(this.sql, principals, f.kb)

    const all: Pair[] = [
      ...acl.recordsPermissionedTo(this.sql, principals, f.apps),
      ...acl.recordsInheritingFrom(this.sql, recordGroups),
      ...acl.kbRecords(this.sql, recordGroups),
      ...acl.anyoneRecords(this.sql, args.orgId),
    ]

    const map: AccessibleMap = {}
    for (const { vid, rid } of all) if (vid && rid && !(vid in map)) map[vid] = rid
    return map
  }

  async getRecordsByRecordIds(recordIds: string[], orgId: string): Promise<RecordDoc[]> {
    if (recordIds.length === 0) return []
    const rows = this.rows<{ id: string; data: string }>(
      `SELECT id, data FROM nodes WHERE coll = 'records' AND id IN (${this.ph(recordIds.length)})
         AND json_extract(data,'$.orgId') = ?`,
      [...recordIds, orgId],
    )
    return rows.map((r) => ({ ...(JSON.parse(r.data) as RecordDoc), _key: r.id }))
  }

  async getUserByUserId(userId: string): Promise<UserDoc | null> {
    return acl.userRow(this.sql, userId)
  }

  async getUserApps(userKey: string): Promise<Array<{ _key?: string; id?: string }>> {
    return this.rows<{ id: string }>(
      `SELECT n.id AS id FROM edges e JOIN nodes n ON n.id = e.dst AND n.coll = 'apps'
       WHERE e.src = ? AND e.label = 'permissions'`,
      [userKey],
    ).map((r) => ({ _key: r.id, id: r.id }))
  }

  /** Record names (within the accessible set) that mention any of the given entities. */
  recordsMentioning(entityIds: string[], accessibleRecordIds: string[]): string[] {
    return kg.recordsMentioning(this.sql, entityIds, accessibleRecordIds)
  }

  async getDocument(recordId: string, collection: string): Promise<RecordDoc | null> {
    const r = this.rows<{ id: string; data: string }>("SELECT id, data FROM nodes WHERE id = ? AND coll = ? LIMIT 1", [
      recordId,
      collection,
    ])[0]
    return r ? { ...(JSON.parse(r.data) as RecordDoc), _key: r.id } : null
  }

  /** GraphRAG hop: records connected to the seeds through shared/related concepts.
   *  seed records → their entities → relates_to neighbors → other records that
   *  mention those neighbors. Constrained to `accessibleRecordIds` (ACL-safe) and
   *  excluding the seeds themselves. */
  getRelatedRecordIds(seedRecordIds: string[], accessibleRecordIds: string[], limit = 5): string[] {
    return kg.getRelatedRecordIds(this.sql, seedRecordIds, accessibleRecordIds, limit)
  }

  /** The knowledge graph the given (already ACL-filtered) records expose:
   *  entities those records mention + relationships among them. ACL-safe because
   *  the caller passes only recordIds the user may access. */
  getKnowledgeGraph(recordIds: string[]): {
    entities: Array<{ id: string; label: string; type: string }>
    relations: Array<{ from: string; to: string; type: string; weight: number }>
  } {
    return kg.getKnowledgeGraph(this.sql, recordIds)
  }
}
