// Resolves which backend the MCP server talks to, from env:
//   • Central office: if CONTEXT_ARANGO_URL/QDRANT_URL/EMBED_URL/COLLECTION are set,
//     query the shared backend with this user's identity → org-wide graph + per-user ACL.
//   • Local embedded (default): a single SQLite file - ingest + query, no servers.
// Identity (who is asking) drives ACL and comes from CONTEXT_USER_ID/CONTEXT_ORG_ID.

import { personalContext, personalContextPath } from "../embedded/personal"
import { buildContextService } from "../service"
import { loadContextConfigFromEnv } from "../config-env"
import type { IngestDoc } from "../embedded/ingest"
import type { RetrievalResponse } from "../types"

export interface KnowledgeGraph {
  entities: Array<{ id: string; label: string; type: string }>
  relations: Array<{ from: string; to: string }>
}

export interface BackendStats {
  records: number
  chunks: number
  entities: number
  relations: number
}

export interface ExactAnswer {
  answer: string
  facts: string[]
  triple: { subject: string; predicate: string; object: string }
  citations: string[]
  confidence: number
}

export interface ContextBackend {
  mode: "central" | "local"
  userId: string
  orgId: string
  /** Where the data lives (db path for local, backend url for central). */
  storage: string
  /** Active vector search engine. */
  vectorIndex: string
  /** Configured embedding mode (auto/transformers/hash, or central). */
  embeddings: string
  /** Knowledge extraction mode - confirms whether the LLM is wired. */
  extraction: string
  query(q: string): Promise<RetrievalResponse>
  /** KGQA: exact answer from the typed graph, or null to fall back to ranked. */
  ask?: (q: string) => Promise<ExactAnswer | null>
  ingest?: (doc: IngestDoc) => Promise<{ recordId: string; chunks: number; entities: number }>
  /** The accessible knowledge graph (entities + relations). Local mode only. */
  graph?: () => Promise<KnowledgeGraph>
  /** Re-extract the knowledge graph over all records with the current extractor
   *  (typed triples when an LLM is configured). Local mode only. */
  rebuild?: () => Promise<{ records: number; entities: number }>
  /** Graph-query surface (ACL-filtered traversal over the entity graph). Local only. */
  graphQuery?: {
    neighbors: (name: string, relation?: string) => Promise<unknown>
    path: (a: string, b: string) => Promise<unknown>
    impact: (name: string) => Promise<unknown>
    central: (limit?: number) => Promise<unknown>
    communities: () => Promise<unknown>
    cypher: () => Promise<string>
    walk: (seeds: string[]) => Promise<unknown>
  }
  /** Live counts for the about/discovery endpoint. */
  stats?: () => Promise<BackendStats>
}

export function resolveBackend(): ContextBackend {
  const central = loadContextConfigFromEnv(process.env)

  if (central) {
    const userId = process.env.CONTEXT_USER_ID
    const orgId = process.env.CONTEXT_ORG_ID
    if (!userId || !orgId) {
      throw new Error("central mode needs CONTEXT_USER_ID and CONTEXT_ORG_ID so results are ACL-filtered")
    }
    const svc = buildContextService(central)
    return {
      mode: "central",
      userId,
      orgId,
      storage: central.qdrant.url,
      vectorIndex: "Qdrant (hybrid + RRF)",
      embeddings: "central embedding service",
      extraction: "central ingestion pipeline",
      // Ingestion in the central tier is normally via connectors - not exposed here.
      query: (q) => svc.retrieval.searchWithFilters({ queries: [q], userId, orgId, limit: 10 }),
    }
  }

  const ctx = personalContext()
  const count = (sql: string) => (ctx.store.db.query(sql).get() as { c: number }).c
  return {
    mode: "local",
    userId: ctx.userId,
    orgId: ctx.orgId,
    storage: personalContextPath(),
    vectorIndex: ctx.store.vecEnabled ? "sqlite-vec ANN (in-process)" : "brute-force cosine",
    embeddings: (process.env.CONTEXT_EMBEDDINGS ?? "auto").toLowerCase(),
    extraction: process.env.CONTEXT_LLM_URL
      ? `LLM typed-triples (${process.env.CONTEXT_LLM_MODEL || "default"} @ ${process.env.CONTEXT_LLM_URL})`
      : "caller-supplied typed triples (the calling model passes entities+relations to context_ingest); " +
        "deterministic fallback when none given",
    query: (q) => ctx.searchWithGraph(q, ctx.userId, ctx.orgId), // vector + ACL + GraphRAG expansion
    ask: (q) => ctx.ask(q, ctx.userId, ctx.orgId), // KGQA: exact answer from the typed graph
    ingest: (doc) => ctx.authorizedIngest(ctx.userId, doc), // write-side authorization + ownership
    graph: async () => {
      const accessible = await ctx.graph.getAccessibleVirtualRecordIds({ userId: ctx.userId, orgId: ctx.orgId })
      const recordIds = [...new Set(Object.values(accessible))]
      return ctx.graph.getKnowledgeGraph(recordIds)
    },
    rebuild: () => ctx.rebuildGraph(),
    graphQuery: {
      neighbors: (name, relation) => ctx.graphQuery.neighbors(name, ctx.userId, ctx.orgId, relation),
      path: (a, b) => ctx.graphQuery.pathBetween(a, b, ctx.userId, ctx.orgId),
      impact: (name) => ctx.graphQuery.impactOf(name, ctx.userId, ctx.orgId),
      central: (limit) => ctx.graphQuery.central(ctx.userId, ctx.orgId, limit),
      communities: () => ctx.graphQuery.communities(ctx.userId, ctx.orgId),
      cypher: () => ctx.graphQuery.toCypher(ctx.userId, ctx.orgId),
      walk: (seeds) => ctx.graphQuery.walk(seeds, ctx.userId, ctx.orgId),
    },
    stats: async () => ({
      records: count("SELECT count(*) c FROM nodes WHERE coll = 'records'"),
      chunks: count("SELECT count(*) c FROM chunks"),
      entities: count("SELECT count(*) c FROM nodes WHERE coll = 'entities'"),
      relations: count("SELECT count(*) c FROM edges WHERE label = 'relates_to'"),
    }),
  }
}
