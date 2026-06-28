// Ported from PipesHub `services/graph_db/arango/arango_http_provider.py`
// (get_accessible_virtual_record_ids + _get_virtual_ids_for_connector +
//  _get_kb_virtual_ids + _get_user_app_ids).
//
// This is the moat. The AQL is preserved verbatim from the source - the eight
// permission paths (direct / group×2 / org×2 / record-group inheritance×2 /
// anyone) and the two KB paths (direct / team). Do not "simplify" a path without
// understanding which access route it represents; each one is a way a user can
// legitimately reach a record, and dropping one silently denies access while
// loosening one silently leaks data.

import type { ArangoClient, GraphProvider } from "./provider"
import type { AccessibleMap, MetadataFilters, RecordDoc, RetrievalFilters, UserDoc } from "./types"

// Arango edge/vertex collection names, matching the source schema.
const C = {
  USERS: "users",
  RECORDS: "records",
  ANYONE: "anyone",
  PERMISSION: "permissions",
  BELONGS_TO: "belongsTo",
  INHERIT_PERMISSIONS: "inheritPermissions",
  BELONGS_TO_DEPARTMENT: "belongsToDepartment",
  BELONGS_TO_CATEGORY: "belongsToCategory",
  BELONGS_TO_LANGUAGE: "belongsToLanguage",
  BELONGS_TO_TOPIC: "belongsToTopic",
} as const

const COMPLETED_STATUS = "COMPLETED"

// Build the optional metadata-facet FILTER lines + their bind vars. Shared by the
// connector and KB queries so both honor department/category/language/topic facets.
function buildMetadataFilters(metadataFilters?: MetadataFilters): {
  clause: string
  bindVars: Record<string, unknown>
} {
  const lines: string[] = []
  const bindVars: Record<string, unknown> = {}
  if (metadataFilters) {
    const facet = (
      values: string[] | undefined,
      edge: string,
      field: string,
      bindName: string,
    ) => {
      if (!values || values.length === 0) return
      lines.push(`
        FILTER LENGTH(
            FOR x IN OUTBOUND record._id ${edge}
            FILTER x.${field} IN @${bindName}
            LIMIT 1
            RETURN 1
        ) > 0`)
      bindVars[bindName] = values
    }
    facet(metadataFilters.departments, C.BELONGS_TO_DEPARTMENT, "departmentName", "departmentNames")
    facet(metadataFilters.categories, C.BELONGS_TO_CATEGORY, "name", "categoryNames")
    facet(metadataFilters.subcategories1, C.BELONGS_TO_CATEGORY, "name", "subcat1Names")
    facet(metadataFilters.subcategories2, C.BELONGS_TO_CATEGORY, "name", "subcat2Names")
    facet(metadataFilters.subcategories3, C.BELONGS_TO_CATEGORY, "name", "subcat3Names")
    facet(metadataFilters.languages, C.BELONGS_TO_LANGUAGE, "name", "languageNames")
    facet(metadataFilters.topics, C.BELONGS_TO_TOPIC, "name", "topicNames")
  }
  return { clause: lines.join("\n"), bindVars }
}

function rowsToMap(rows: any[]): AccessibleMap {
  const map: AccessibleMap = {}
  for (const r of rows ?? []) {
    if (r && r.virtualRecordId && r.recordId) map[r.virtualRecordId] = r.recordId
  }
  return map
}

export class ArangoGraphProvider implements GraphProvider {
  constructor(
    private readonly client: ArangoClient,
    private readonly log: { error: (m: string, ...a: unknown[]) => void; debug?: (m: string) => void } = {
      error: () => {},
    },
  ) {}

  async getUserByUserId(userId: string): Promise<UserDoc | null> {
    const rows = await this.client.executeAql(
      `FOR user IN @@users FILTER user.userId == @userId LIMIT 1 RETURN user`,
      { userId, "@users": C.USERS },
    )
    return rows?.[0] ?? null
  }

  async getUserApps(userKey: string): Promise<Array<{ _key?: string; id?: string }>> {
    // Apps the user can reach. Kept as a seam - wire to the source's get_user_apps
    // traversal. Returning [] means "connectors contribute nothing"; KB paths still run.
    const rows = await this.client.executeAql(
      `FOR app IN 1..1 ANY @userKey @@permission
         FILTER IS_SAME_COLLECTION("apps", app)
         RETURN app`,
      { userKey: `${C.USERS}/${userKey}`, "@permission": C.PERMISSION },
    )
    return rows ?? []
  }

  private async getUserAppIds(userId: string): Promise<string[]> {
    const user = await this.getUserByUserId(userId)
    if (!user) return []
    const userKey = user._key ?? user.id
    if (!userKey) return []
    const apps = await this.getUserApps(userKey)
    return apps.map((a) => a._key ?? a.id).filter((x): x is string => Boolean(x))
  }

  // --- THE moat orchestration: union of connector paths + KB path, deduped. ---
  async getAccessibleVirtualRecordIds(args: {
    userId: string
    orgId: string
    filters?: RetrievalFilters
  }): Promise<AccessibleMap> {
    const { userId, orgId } = args
    const filters = args.filters ?? {}
    try {
      const userAppIds = await this.getUserAppIds(userId)
      const kbIds = filters.kb
      const connectorIdsFilter = filters.apps
      const { kb: _kb, apps: _apps, ...metadataFilters } = filters

      const hasKbFilter = Boolean(kbIds && kbIds.length)
      const hasAppFilter = Boolean(connectorIdsFilter && connectorIdsFilter.length)

      const tasks: Promise<AccessibleMap>[] = []
      const connectors = (ids: string[]) =>
        ids.filter((cid) => !cid.startsWith("knowledgeBase_"))

      if (hasAppFilter && hasKbFilter) {
        for (const cid of connectors(userAppIds.filter((c) => connectorIdsFilter!.includes(c))))
          tasks.push(this.getVirtualIdsForConnector(userId, orgId, cid, metadataFilters))
        tasks.push(this.getKbVirtualIds(userId, orgId, kbIds!, metadataFilters))
      } else if (!hasAppFilter && hasKbFilter) {
        tasks.push(this.getKbVirtualIds(userId, orgId, kbIds!, metadataFilters))
      } else if (!hasAppFilter && !hasKbFilter) {
        for (const cid of connectors(userAppIds))
          tasks.push(this.getVirtualIdsForConnector(userId, orgId, cid, metadataFilters))
        tasks.push(this.getKbVirtualIds(userId, orgId, undefined, metadataFilters))
      } else {
        for (const cid of connectors(userAppIds.filter((c) => connectorIdsFilter!.includes(c))))
          tasks.push(this.getVirtualIdsForConnector(userId, orgId, cid, metadataFilters))
      }

      if (tasks.length === 0) return {}

      const results = await Promise.allSettled(tasks)
      const merged: AccessibleMap = {}
      for (const r of results) {
        if (r.status !== "fulfilled") {
          this.log.error(`accessible-ids task failed: ${String(r.reason)}`)
          continue
        }
        // First writer wins per virtualRecordId - mirrors the source's dedup so a
        // record reachable via several paths resolves to a single recordId.
        for (const [vid, rid] of Object.entries(r.value)) if (!(vid in merged)) merged[vid] = rid
      }
      return merged
    } catch (e) {
      this.log.error(`getAccessibleVirtualRecordIds failed: ${String(e)}`)
      return {}
    }
  }

  // The eight permission paths for one connector.
  private async getVirtualIdsForConnector(
    userId: string,
    orgId: string,
    connectorId: string,
    metadataFilters?: MetadataFilters,
  ): Promise<AccessibleMap> {
    const { clause, bindVars: mdBind } = buildMetadataFilters(metadataFilters)
    const query = `
    LET userDoc = FIRST(FOR user IN @@users FILTER user.userId == @userId RETURN user)

    LET directRecords = (
        FOR record IN 1..1 ANY userDoc._id ${C.PERMISSION}
            FILTER IS_SAME_COLLECTION("records", record)
            FILTER record.connectorId == @connectorId
            FILTER record.indexingStatus == @completedStatus
            ${clause}
            RETURN {virtualRecordId: record.virtualRecordId, recordId: record._key}
    )
    LET groupRecords = (
        FOR group IN 1..1 ANY userDoc._id ${C.BELONGS_TO}
            FOR record IN 1..1 ANY group._id ${C.PERMISSION}
                FILTER IS_SAME_COLLECTION("records", record)
                FILTER record.connectorId == @connectorId
                FILTER record.indexingStatus == @completedStatus
                ${clause}
                RETURN {virtualRecordId: record.virtualRecordId, recordId: record._key}
    )
    LET groupRecordsPermissionEdge = (
        FOR group IN 1..1 ANY userDoc._id ${C.PERMISSION}
            FOR record IN 1..1 ANY group._id ${C.PERMISSION}
                FILTER IS_SAME_COLLECTION("records", record)
                FILTER record.connectorId == @connectorId
                FILTER record.indexingStatus == @completedStatus
                ${clause}
                RETURN {virtualRecordId: record.virtualRecordId, recordId: record._key}
    )
    LET orgRecords = (
        FOR org IN 1..1 ANY userDoc._id ${C.BELONGS_TO}
            FOR record IN 1..1 ANY org._id ${C.PERMISSION}
                FILTER IS_SAME_COLLECTION("records", record)
                FILTER record.connectorId == @connectorId
                FILTER record.indexingStatus == @completedStatus
                ${clause}
                RETURN {virtualRecordId: record.virtualRecordId, recordId: record._key}
    )
    LET orgRecordGroupRecords = (
        FOR org IN 1..1 ANY userDoc._id ${C.BELONGS_TO}
            FOR recordGroup IN 1..1 ANY org._id ${C.PERMISSION}
                FILTER IS_SAME_COLLECTION("recordGroups", recordGroup)
                FOR record IN 0..2 INBOUND recordGroup._id ${C.INHERIT_PERMISSIONS}
                    FILTER IS_SAME_COLLECTION("records", record)
                    FILTER record.connectorId == @connectorId
                    FILTER record.indexingStatus == @completedStatus
                    ${clause}
                    RETURN {virtualRecordId: record.virtualRecordId, recordId: record._key}
    )
    LET recordGroupRecords = (
        FOR group IN 1..1 ANY userDoc._id ${C.PERMISSION}
            FILTER IS_SAME_COLLECTION("groups", group) OR IS_SAME_COLLECTION("roles", group)
            FOR recordGroup IN 1..1 ANY group._id ${C.PERMISSION}
                FOR record IN 0..5 INBOUND recordGroup._id ${C.INHERIT_PERMISSIONS}
                    FILTER IS_SAME_COLLECTION("records", record)
                    FILTER record.connectorId == @connectorId
                    FILTER record.indexingStatus == @completedStatus
                    ${clause}
                    RETURN {virtualRecordId: record.virtualRecordId, recordId: record._key}
    )
    LET inheritedRecordGroupRecords = (
        FOR recordGroup IN 1..1 ANY userDoc._id ${C.PERMISSION}
            FILTER IS_SAME_COLLECTION("recordGroups", recordGroup)
            FOR record IN 0..5 INBOUND recordGroup._id ${C.INHERIT_PERMISSIONS}
                FILTER IS_SAME_COLLECTION("records", record)
                FILTER record.connectorId == @connectorId
                FILTER record.indexingStatus == @completedStatus
                ${clause}
                RETURN {virtualRecordId: record.virtualRecordId, recordId: record._key}
    )
    LET anyoneRecords = (
        FOR anyone IN @@anyone
            FILTER anyone.organization == @orgId
            FOR record IN @@records
                FILTER record._key == anyone.file_key
                FILTER record.connectorId == @connectorId
                FILTER record.indexingStatus == @completedStatus
                ${clause}
                RETURN {virtualRecordId: record.virtualRecordId, recordId: record._key}
    )
    LET allPairs = UNION(
        directRecords, groupRecords, groupRecordsPermissionEdge,
        orgRecords, orgRecordGroupRecords, recordGroupRecords,
        inheritedRecordGroupRecords, anyoneRecords
    )
    FOR pair IN allPairs
        FILTER pair != null AND pair.virtualRecordId != null AND pair.recordId != null
        COLLECT virtualRecordId = pair.virtualRecordId INTO groups
        LET recordId = FIRST(groups).pair.recordId
        FILTER recordId != null
        RETURN {virtualRecordId: virtualRecordId, recordId: recordId}`

    try {
      const rows = await this.client.executeAql(query, {
        userId,
        orgId,
        connectorId,
        completedStatus: COMPLETED_STATUS,
        "@users": C.USERS,
        "@records": C.RECORDS,
        "@anyone": C.ANYONE,
        ...mdBind,
      })
      return rowsToMap(rows)
    } catch (e) {
      this.log.error(`connector ${connectorId} acl query failed: ${String(e)}`)
      return {}
    }
  }

  // KB (RecordGroup) paths: direct membership + team membership.
  private async getKbVirtualIds(
    userId: string,
    _orgId: string,
    kbIds?: string[],
    metadataFilters?: MetadataFilters,
  ): Promise<AccessibleMap> {
    const { clause, bindVars: mdBind } = buildMetadataFilters(metadataFilters)
    const kbFilter = kbIds && kbIds.length ? "FILTER kb._key IN @kb_ids" : ""
    const query = `
    LET userDoc = FIRST(FOR user IN @@users FILTER user.userId == @userId RETURN user)

    LET directKbRecords = (
        FOR kb IN 1..1 ANY userDoc._id ${C.PERMISSION}
            FILTER IS_SAME_COLLECTION("recordGroups", kb)
            ${kbFilter}
        FOR record IN 1..1 ANY kb._id ${C.BELONGS_TO}
            FILTER IS_SAME_COLLECTION("records", record)
            FILTER record.origin == "UPLOAD"
            FILTER record.indexingStatus == @completedStatus
            ${clause}
            RETURN {virtualRecordId: record.virtualRecordId, recordId: record._key}
    )
    LET teamKbRecords = (
        FOR team, userTeamEdge IN 1..1 OUTBOUND userDoc._id ${C.PERMISSION}
            FILTER IS_SAME_COLLECTION("teams", team)
            FILTER userTeamEdge.type == "USER"
        FOR kb, teamKbEdge IN 1..1 OUTBOUND team._id ${C.PERMISSION}
            FILTER IS_SAME_COLLECTION("recordGroups", kb)
            FILTER teamKbEdge.type == "TEAM"
            ${kbFilter}
        FOR record IN 1..1 ANY kb._id ${C.BELONGS_TO}
            FILTER IS_SAME_COLLECTION("records", record)
            FILTER record.origin == "UPLOAD"
            FILTER record.indexingStatus == @completedStatus
            ${clause}
            RETURN {virtualRecordId: record.virtualRecordId, recordId: record._key}
    )
    LET allKbPairs = UNION(directKbRecords, teamKbRecords)
    FOR pair IN allKbPairs
        FILTER pair != null AND pair.virtualRecordId != null AND pair.recordId != null
        COLLECT virtualRecordId = pair.virtualRecordId INTO groups
        LET recordId = FIRST(groups).pair.recordId
        FILTER recordId != null
        RETURN {virtualRecordId: virtualRecordId, recordId: recordId}`

    try {
      const bind: Record<string, unknown> = {
        userId,
        completedStatus: COMPLETED_STATUS,
        "@users": C.USERS,
        ...mdBind,
      }
      if (kbIds && kbIds.length) bind.kb_ids = kbIds
      const rows = await this.client.executeAql(query, bind)
      return rowsToMap(rows)
    } catch (e) {
      this.log.error(`kb acl query failed: ${String(e)}`)
      return {}
    }
  }

  async getRecordsByRecordIds(recordIds: string[], orgId: string): Promise<RecordDoc[]> {
    if (recordIds.length === 0) return []
    const rows = await this.client.executeAql(
      `FOR record IN @@records FILTER record._key IN @recordIds AND record.orgId == @orgId RETURN record`,
      { "@records": C.RECORDS, recordIds, orgId },
    )
    return rows ?? []
  }

  async getDocument(recordId: string, collection: string): Promise<RecordDoc | null> {
    const rows = await this.client.executeAql(
      `FOR d IN @@col FILTER d._key == @recordId LIMIT 1 RETURN d`,
      { "@col": collection, recordId },
    )
    return rows?.[0] ?? null
  }
}
