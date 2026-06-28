// The seams. The ACL + retrieval *logic* is native TS (graph-provider.ts /
// retrieval.ts); the actual datastores plug in behind these interfaces so the
// moat stays runtime-agnostic (ArangoDB today, anything tomorrow).

import type { AccessibleMap, RecordDoc, RetrievalFilters, UserDoc } from "./types"

/** Thin transport to ArangoDB. Implement with arangojs or the org's HTTP client. */
export interface ArangoClient {
  executeAql(query: string, bindVars: Record<string, unknown>): Promise<any[]>
}

/** Graph store: identity, the ACL traversal, and record fetches. */
export interface GraphProvider {
  /** THE moat: virtualRecordId -> recordId for everything the user may access. */
  getAccessibleVirtualRecordIds(args: {
    userId: string
    orgId: string
    filters?: RetrievalFilters
  }): Promise<AccessibleMap>

  getRecordsByRecordIds(recordIds: string[], orgId: string): Promise<RecordDoc[]>
  getUserByUserId(userId: string): Promise<UserDoc | null>
  getUserApps(userKey: string): Promise<Array<{ _key?: string; id?: string }>>
  getDocument(recordId: string, collection: string): Promise<RecordDoc | null>
}

/** Vector store contract - hybrid (dense + sparse, RRF) search over Qdrant-shaped
 *  payloads. `filterCollection` builds the must/should filter restricting the
 *  search to ACL-approved virtualRecordIds. */
export interface VectorPoint {
  id: string | number
  score: number
  payload: { page_content?: string; metadata?: Record<string, unknown> }
}

export interface VectorQueryResult {
  points: VectorPoint[]
}

export interface VectorDBService {
  filterCollection(args: {
    must?: Record<string, unknown>
    should?: Record<string, unknown>
  }): Promise<unknown>

  queryNearestPoints(args: {
    collectionName: string
    requests: unknown[]
  }): Promise<VectorQueryResult[]>
}

/** Embedding provider - dense + sparse (BM25) for hybrid retrieval. `embedDense`
 *  embeds DOCUMENTS (chunks); `embedQuery` embeds the QUERY. They differ for
 *  asymmetric models (e.g. EmbeddingGemma's task prefixes); symmetric models leave
 *  `embedQuery` undefined and callers fall back to `embedDense`. */
export interface EmbeddingProvider {
  embedDense(query: string): Promise<number[]>
  embedQuery?(query: string): Promise<number[]>
  embedSparse(query: string): Promise<{ indices: number[]; values: number[] }>
}

/** Embed a QUERY with the asymmetric path when the provider has one, else the doc path. */
export function embedQueryWith(emb: EmbeddingProvider, text: string): Promise<number[]> {
  return emb.embedQuery ? emb.embedQuery(text) : emb.embedDense(text)
}
