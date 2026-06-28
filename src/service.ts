// Wires config → fetch-based adapters → the native ACL/retrieval moat. This is
// the only place that knows about concrete backends; everything above depends on
// the interfaces in provider.ts. No Python, no SDKs - direct HTTP to Arango/Qdrant
// and the embedding server.

import { ArangoHttpClient, type ArangoConfig } from "./arango-client"
import { QdrantVectorService, type QdrantConfig } from "./qdrant-vector"
import { HttpEmbeddingProvider, type EmbeddingConfig } from "./embeddings"
import { ArangoGraphProvider } from "./arango-graph-provider"
import { RetrievalService } from "./retrieval"

export interface ContextConfig {
  arango: ArangoConfig
  qdrant: QdrantConfig
  embeddings: EmbeddingConfig
  collectionName: string
}

export interface ContextLog {
  info: (m: string) => void
  debug: (m: string) => void
  error: (m: string, ...a: unknown[]) => void
}

/** Build a fully-wired retrieval service from config. */
export function buildContextService(cfg: ContextConfig, log?: ContextLog) {
  const graph = new ArangoGraphProvider(new ArangoHttpClient(cfg.arango), log)
  const vector = new QdrantVectorService(cfg.qdrant)
  const embeddings = new HttpEmbeddingProvider(cfg.embeddings)
  const retrieval = new RetrievalService({
    graph,
    vector,
    embeddings,
    collectionName: cfg.collectionName,
    log,
  })
  return { graph, vector, embeddings, retrieval }
}

export type ContextService = ReturnType<typeof buildContextService>
