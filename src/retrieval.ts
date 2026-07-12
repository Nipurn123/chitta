// Ported from PipesHub `modules/retrieval/retrieval_service.py::search_with_filters`.
//
// The security-critical invariant, preserved exactly:
//   1. Compute the user's accessible {virtualRecordId -> recordId} map from the
//      GRAPH first (ACL). 2. Restrict the vector search to those virtual ids.
//   3. For every hit, resolve the recordId from the ACCESSIBLE MAP - never from
//      the vector payload. That step is the cross-connector leak guard: a shared
//      virtualRecordId only ever resolves to the record THIS user may see.
//
// The cosmetic webUrl/mime fallback enrichment for file/mail records
// (retrieval_service.py:462-532) is intentionally omitted here - it is
// presentation, not access control. Port it later if you need source links.

import { embedQueryWith, type EmbeddingProvider, type GraphProvider, type VectorDBService, type VectorPoint } from "./provider"
import {
  ACCESSIBLE_RECORDS_NOT_FOUND_MESSAGE,
  RetrievalStatus,
  type RecordDoc,
  type RetrievalFilters,
  type RetrievalResponse,
  type SearchResult,
  type UserDoc,
} from "./types"

const REQUIRED_FIELDS = ["origin", "recordName", "recordId", "mimeType", "orgId"] as const

export interface RetrievalDeps {
  graph: GraphProvider
  vector: VectorDBService
  embeddings: EmbeddingProvider
  collectionName: string
  log?: { info: (m: string) => void; debug: (m: string) => void; error: (m: string) => void }
}

export class RetrievalService {
  constructor(private readonly deps: RetrievalDeps) {}
  private get log() {
    return this.deps.log ?? { info() {}, debug() {}, error() {} }
  }

  async searchWithFilters(args: {
    queries: string[]
    userId: string
    orgId: string
    filterGroups?: RetrievalFilters
    limit?: number
    virtualRecordIdsFromTool?: string[]
  }): Promise<RetrievalResponse> {
    const { queries, userId, orgId } = args
    const limit = args.limit ?? 20
    const filterGroups = args.filterGroups ?? {}
    const kbIds = filterGroups.kb

    try {
      // (1) ACL + user, in parallel.
      const [accessibleMap, user] = await Promise.all([
        this.deps.graph.getAccessibleVirtualRecordIds({ userId, orgId, filters: filterGroups }),
        this.deps.graph.getUserByUserId(userId),
      ])

      // Accessible VID set, memoized by map identity when the provider supports it (embedded) -
      // so the O(N) "keys of the whole ACL" work is paid once per data-version, not per query.
      const allowedVidSet = this.deps.graph.accessibleVidSet?.(accessibleMap)
      const isEmpty = allowedVidSet ? allowedVidSet.size === 0 : Object.keys(accessibleMap).length === 0
      if (isEmpty) {
        this.log.error(`No accessible documents for user ${userId} org ${orgId}`)
        return this.empty(ACCESSIBLE_RECORDS_NOT_FOUND_MESSAGE, RetrievalStatus.ACCESSIBLE_RECORDS_NOT_FOUND)
      }

      // (2) Vector filter restricted to ACL-approved virtual ids. Pass the memoized SET straight
      // through when we have it (embedded → no per-query array/Set rebuild); otherwise fall back
      // to the id array (cloud adapters). Either way the ACL restriction is identical.
      const filter = args.virtualRecordIdsFromTool
        ? await this.deps.vector.filterCollection({
            must: { orgId, virtualRecordId: args.virtualRecordIdsFromTool },
          })
        : await this.deps.vector.filterCollection({
            must: { orgId },
            should: allowedVidSet ? { virtualRecordIdSet: allowedVidSet } : { virtualRecordId: Object.keys(accessibleMap) },
          })

      const searchResults = await this.executeParallelSearches(queries, filter, limit)
      if (searchResults.length === 0)
        return this.empty(
          "No relevant documents found for your search query. Try different keywords.",
          RetrievalStatus.EMPTY_RESPONSE,
        )

      const returnedVirtualIds = [
        ...new Set(
          searchResults
            .map((r) => r.metadata?.virtualRecordId)
            .filter((v): v is string => v != null),
        ),
      ]
      if (returnedVirtualIds.length === 0)
        return this.empty(ACCESSIBLE_RECORDS_NOT_FOUND_MESSAGE, RetrievalStatus.ACCESSIBLE_RECORDS_NOT_FOUND)

      // (3) THE leak guard: resolve recordIds ONLY through the accessible map.
      const recordIdsToFetch = [
        ...new Set(returnedVirtualIds.filter((v) => v in accessibleMap).map((v) => accessibleMap[v])),
      ]

      const fetched = await this.deps.graph.getRecordsByRecordIds(recordIdsToFetch, orgId)
      if (!fetched || fetched.length === 0)
        return this.empty(ACCESSIBLE_RECORDS_NOT_FOUND_MESSAGE, RetrievalStatus.ACCESSIBLE_RECORDS_NOT_FOUND)

      const recordById = new Map<string, RecordDoc>()
      for (const r of fetched) if (r?._key) recordById.set(r._key, r)

      // Enrich each result with its (permission-verified) record metadata.
      const enriched: SearchResult[] = []
      for (const result of searchResults) {
        const vid = result.metadata?.virtualRecordId
        if (vid == null || !(vid in accessibleMap)) continue // not permitted → drop
        const recordId = accessibleMap[vid]
        const record = recordById.get(recordId)
        result.metadata.recordId = recordId
        if (record) {
          result.metadata.origin = record.origin
          result.metadata.connector = record.connectorName ?? null
          result.metadata.connectorId = record.connectorId ?? null
          result.metadata.kbId = record.kbId ?? null
          result.metadata.recordName = record.recordName
          result.metadata.orgId = orgId
          let weburl = record.webUrl
          if (weburl?.startsWith("https://mail.google.com/mail?authuser=") && (user as UserDoc | null)?.email)
            weburl = weburl.replace("{user.email}", (user as UserDoc).email!)
          if (weburl) result.metadata.webUrl = weburl
          if (record.mimeType) result.metadata.mimeType = record.mimeType
        }
        enriched.push(result)
      }

      enriched.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))

      // Drop results missing fields citation validation requires.
      const complete = enriched.filter((r) => {
        if (!r.content) return false
        return REQUIRED_FIELDS.every((f) => (r.metadata as Record<string, unknown>)[f] != null)
      })

      const records = recordIdsToFetch.map((id) => recordById.get(id)).filter((r): r is RecordDoc => Boolean(r))

      if (complete.length === 0 && records.length === 0)
        return this.empty(
          "No relevant documents found for your search query.",
          RetrievalStatus.EMPTY_RESPONSE,
        )

      const resp: RetrievalResponse = {
        searchResults: complete,
        records,
        status: RetrievalStatus.SUCCESS,
        statusCode: 200,
        message: "Query processed successfully. Relevant records retrieved.",
      }
      if (kbIds?.length) resp.appliedFilters = { kb: kbIds, kb_count: kbIds.length }
      return resp
    } catch (e) {
      this.log.error(`Filtered search failed: ${String(e)}`)
      return this.empty("Unexpected server error during search.", RetrievalStatus.ERROR)
    }
  }

  // Hybrid dense+sparse retrieval with RRF fusion. The request shape is
  // Qdrant-flavored; the VectorDBService adapter forwards it to the client.
  private async executeParallelSearches(
    queries: string[],
    filter: unknown,
    limit: number,
  ): Promise<SearchResult[]> {
    const requests = await Promise.all(
      queries.map(async (q) => {
        const [dense, sparse] = await Promise.all([
          embedQueryWith(this.deps.embeddings, q), // QUERY embedding (asymmetric-aware)
          this.deps.embeddings.embedSparse(q),
        ])
        return {
          prefetch: [
            { query: dense, using: "dense", limit: limit * 2, filter },
            { query: sparse, using: "sparse", limit: limit * 2, filter },
          ],
          query: { fusion: "RRF" },
          with_payload: true,
          limit,
          filter,
        }
      }),
    )

    const results = await this.deps.vector.queryNearestPoints({
      collectionName: this.deps.collectionName,
      requests,
    })

    const seen = new Set<string | number>()
    const out: SearchResult[] = []
    for (const r of results)
      for (const p of r.points as VectorPoint[]) {
        if (seen.has(p.id)) continue
        seen.add(p.id)
        const metadata = { ...(p.payload.metadata ?? {}), point_id: p.id }
        out.push({
          score: p.score,
          citationType: "vectordb|document",
          metadata,
          content: p.payload.page_content ?? "",
        })
      }
    return out
  }

  private empty(message: string, status: RetrievalStatus): RetrievalResponse {
    const codes: Record<RetrievalStatus, number> = {
      [RetrievalStatus.SUCCESS]: 200,
      [RetrievalStatus.ERROR]: 500,
      [RetrievalStatus.ACCESSIBLE_RECORDS_NOT_FOUND]: 404,
      [RetrievalStatus.VECTOR_DB_EMPTY]: 503,
      [RetrievalStatus.EMPTY_RESPONSE]: 200,
    }
    return { searchResults: [], records: [], status, statusCode: codes[status] ?? 500, message }
  }
}
