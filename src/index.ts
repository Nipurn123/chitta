// Context layer - the permission-aware retrieval moat, ported natively to TS.
// See ./README.md for the port provenance and what still plugs in behind the seams.

export * from "./permission"
export * from "./types"
export * from "./provider"
export { ArangoGraphProvider } from "./arango-graph-provider"
export { RetrievalService, type RetrievalDeps } from "./retrieval"
export { ArangoHttpClient, type ArangoConfig } from "./arango-client"
export { QdrantVectorService, type QdrantConfig } from "./qdrant-vector"
export { HttpEmbeddingProvider, type EmbeddingConfig } from "./embeddings"
export { buildContextService, type ContextConfig, type ContextService, type ContextLog } from "./service"

import { ArangoGraphProvider } from "./arango-graph-provider"
import { RetrievalService } from "./retrieval"
import type { ArangoClient, EmbeddingProvider, VectorDBService } from "./provider"

/** Build a ready retrieval service from the three backend seams. */
export function createContext(opts: {
  arango: ArangoClient
  vector: VectorDBService
  embeddings: EmbeddingProvider
  collectionName: string
  log?: RetrievalServiceLog
}) {
  const graph = new ArangoGraphProvider(opts.arango, opts.log)
  const retrieval = new RetrievalService({
    graph,
    vector: opts.vector,
    embeddings: opts.embeddings,
    collectionName: opts.collectionName,
    log: opts.log,
  })
  return { graph, retrieval }
}

type RetrievalServiceLog = {
  info: (m: string) => void
  debug: (m: string) => void
  error: (m: string, ...a: unknown[]) => void
}

// Re-export the backend seam types for callers wiring adapters.
export type { ArangoClient, EmbeddingProvider, VectorDBService } from "./provider"
