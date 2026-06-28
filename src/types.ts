// Shared types for the context-retrieval layer. Ported from the data shapes used
// across PipesHub's Query service (`retrieval_service.py`) and Arango provider.

/** virtualRecordId -> recordId. Each virtual id maps to the ONE record the user
 *  is actually permitted to see (the cross-connector leak guard lives here). */
export type AccessibleMap = Record<string, string>

/** Optional retrieval filters. `kb`/`apps` scope the corpus; the rest are
 *  metadata facets resolved against graph edges. */
export interface RetrievalFilters {
  kb?: string[]
  apps?: string[]
  departments?: string[]
  categories?: string[]
  subcategories1?: string[]
  subcategories2?: string[]
  subcategories3?: string[]
  languages?: string[]
  topics?: string[]
}

/** Metadata filters = everything except kb/apps. */
export type MetadataFilters = Omit<RetrievalFilters, "kb" | "apps">

export interface RecordDoc {
  _key: string
  virtualRecordId?: string
  origin?: string
  connectorName?: string
  connectorId?: string
  kbId?: string
  webUrl?: string
  recordName?: string
  recordType?: string
  mimeType?: string
  previewRenderable?: boolean
  hideWeburl?: boolean
  [k: string]: unknown
}

export interface UserDoc {
  _key?: string
  id?: string
  userId?: string
  email?: string
  [k: string]: unknown
}

export interface SearchResultMeta {
  virtualRecordId?: string
  recordId?: string
  orgId?: string
  origin?: string
  connector?: string | null
  connectorId?: string | null
  kbId?: string | null
  webUrl?: string
  recordName?: string
  mimeType?: string
  extension?: string
  point_id?: string | number
  [k: string]: unknown
}

export interface SearchResult {
  score: number
  citationType: string
  metadata: SearchResultMeta
  content: string
}

export enum RetrievalStatus {
  SUCCESS = "SUCCESS",
  ERROR = "ERROR",
  EMPTY_RESPONSE = "EMPTY_RESPONSE",
  ACCESSIBLE_RECORDS_NOT_FOUND = "ACCESSIBLE_RECORDS_NOT_FOUND",
  VECTOR_DB_EMPTY = "VECTOR_DB_EMPTY",
}

export interface RetrievalResponse {
  searchResults: SearchResult[]
  records: RecordDoc[]
  status: RetrievalStatus
  statusCode: number
  message: string
  appliedFilters?: { kb: string[]; kb_count: number }
}

export const ACCESSIBLE_RECORDS_NOT_FOUND_MESSAGE =
  "No documents are available for you to search yet. Upload files in Collections " +
  "and/or connect a data source under Connectors so content can be indexed."
