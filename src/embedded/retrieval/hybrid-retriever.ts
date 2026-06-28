// HYBRID retrieval orchestrator - three complementary signals fused with Reciprocal
// Rank Fusion (the 2026 production default), then re-ranked. Signals:
//   • DENSE  (vector + ACL) - semantic similarity (paraphrase, meaning).
//   • SPARSE (BM25 / FTS5)  - exact tokens dense misses (acronyms "SAP", "£230M").
//   • GRAPH  (GraphRAG)     - chunks reachable through related concepts.
// RRF score = Σ 1/(k + rank) across the lists a chunk appears in (k=60), so a chunk
// strong in ANY signal surfaces, and one strong in several rises to the top - with no
// score-scale calibration between cosine and BM25. Then: personal boost (ownership),
// memory decay/salience, cross-encoder rerank, passage extraction, diversity cap (MMR).
// All tunable via CONTEXT_* env.
import type { RetrievalService } from "../../retrieval"
import type { SqliteStore } from "../sqlite-store"
import type { SqliteGraphProvider } from "../sqlite-graph-provider"
import type { Reranker } from "../reranker"
import type { EmbeddingProvider } from "../../provider"
import type { RetrievalResponse } from "../../types"
import { vectorStage } from "./vector-stage"
import { keywordStage } from "./keyword-stage"
import { graphStage } from "./graph-stage"
import { rrfFuse, backfillMeta } from "./fuse"
import { decayConfig, decayStage } from "./decay-stage"
import { rerankStage } from "./rerank-stage"
import { diversityStage } from "./diversity"
import { populateTrace, type SearchTrace } from "./trace"

export interface HybridDeps {
  retrieval: RetrievalService
  store: SqliteStore
  graph: SqliteGraphProvider
  embeddings: EmbeddingProvider
  reranker?: Reranker
}

export async function hybridSearch(
  deps: HybridDeps,
  query: string,
  userId: string,
  orgId: string,
  trace?: SearchTrace,
): Promise<RetrievalResponse> {
  const { retrieval, store, graph, embeddings, reranker } = deps
  const retrieveLimit = Number(process.env.CONTEXT_RETRIEVE_LIMIT ?? 20)
  const accMap = await graph.getAccessibleVirtualRecordIds({ userId, orgId })
  const accessibleVids = new Set(Object.keys(accMap))

  // ── signal 1: DENSE (vector + ACL) ──
  const { dense, res } = await vectorStage(retrieval, query, userId, orgId, retrieveLimit)

  // ── signal 2: SPARSE (BM25) ──
  const bm25 = keywordStage(store, query, orgId, accessibleVids, retrieveLimit)

  // ── signal 3: GRAPH expansion (concept-connected chunks) ──
  const graphList = await graphStage(graph, store, embeddings, query, orgId, dense, accMap)

  // ── Reciprocal Rank Fusion ──
  const K = Number(process.env.CONTEXT_RRF_K ?? 60)
  const merged = rrfFuse(dense, bm25, graphList, K)
  backfillMeta(store, merged, accMap)

  // ── re-rank: personal boost + memory decay/salience (sorts merged) ──
  const cfg = decayConfig()
  decayStage(store, merged, userId, cfg)

  const topk = Number(process.env.CONTEXT_TOPK ?? 6)
  const ratio = Number(process.env.CONTEXT_RRF_RATIO ?? 0.3) // relative cutoff on fused score
  const initialCutoff = (merged[0]?.rrf ?? 0) * ratio

  // ── final stage: CROSS-ENCODER RERANK (optional) ──
  const { ordered, cutoff, rerankerUsed } = await rerankStage(reranker, query, merged, initialCutoff)

  // ── passage extraction + diversity cap + topk (+ access touch) ──
  const relevant = diversityStage(store, ordered, query, cutoff, cfg.maxPerRecord, topk, cfg.decayOn)

  // retrieval trace for the UI: counts per signal + which legs found each top item.
  if (trace) populateTrace(trace, dense, bm25, graphList, merged, ordered, rerankerUsed)

  return { ...res, searchResults: relevant }
}

export type { SearchTrace } from "./trace"
