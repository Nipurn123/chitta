// HYBRID retrieval orchestrator - complementary signals fused with Reciprocal
// Rank Fusion (the 2026 production default), then re-ranked. Signals:
//   • DENSE  (vector + ACL) - semantic similarity (paraphrase, meaning).
//   • SPARSE (BM25 / FTS5)  - exact tokens dense misses (acronyms "SAP", "£230M").
//   • GRAPH  (GraphRAG)     - chunks reachable through related concepts (1 hop).
//   • PPR    (HippoRAG)     - multi-hop: Personalized PageRank from the query's
//     entities over the ACL-scoped typed graph (CONTEXT_GRAPH_PPR, default off -
//     measured neutral on LoCoMo dialogues; see ppr-stage.ts for when to enable).
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
import { pprStage, pprEnabled } from "./ppr-stage"
import { rrfFuse, backfillMeta, mergeFused } from "./fuse"
import { expansionTerms } from "./prf"
import { decayConfig, decayStage } from "./decay-stage"
import { timeStage } from "./time-stage"
import { rerankStage } from "./rerank-stage"
import { diversityStage } from "./diversity"
import { populateTrace, type SearchTrace } from "./trace"

export interface HybridDeps {
  retrieval: RetrievalService
  store: SqliteStore
  graph: SqliteGraphProvider
  embeddings: EmbeddingProvider
  reranker?: Reranker
  /** LLM mode: rewrites a question into searches that name what the answering memory is about. */
  expander?: { expandQuery(question: string): Promise<string[]> }
}

export async function hybridSearch(
  deps: HybridDeps,
  query: string,
  userId: string,
  orgId: string,
  trace?: SearchTrace,
  limit?: number,
  opts: {
    /** "Now" for relative time in the query ("a week ago") - defaults to the current time. */
    now?: number
    /** Search rewrites already computed by the caller (the reader's router) - used instead of
     *  calling the expander again. */
    expansions?: string[]
  } = {},
): Promise<RetrievalResponse> {
  const now = opts.now
  const { retrieval, store, graph, embeddings, reranker } = deps
  const topk = limit && limit > 0 ? limit : Number(process.env.CONTEXT_TOPK ?? 8)
  // Candidate pool per signal = max(400, 8× topk) chunks. Chunks, not records: on chat data a
  // session is ~37 chunks, so a pool of 80 (the old 8× topk) held only a handful of sessions and
  // the gold one was often outside it. Measured on pooled LongMemEval (53k chunks) together with
  // distinct-record selection: same latency, +5.7 points all-gold@10. (8× topk itself was +2.7
  // pts LoCoMo recall@10 over a flat 20.) Zero extra tokens - only the final top-k is returned.
  // Override with CONTEXT_RETRIEVE_LIMIT; floored at topk*2.
  const retrieveLimit = Math.max(Number(process.env.CONTEXT_RETRIEVE_LIMIT ?? Math.max(400, topk * 8)), topk * 2)
  const accMap = await graph.getAccessibleVirtualRecordIds({ userId, orgId })
  // memoized by accMap identity → O(1) across queries (was an O(N) rebuild each call)
  const accessibleVids = graph.accessibleVidSet(accMap)

  // ── signal 1: DENSE (vector + ACL) ──
  const { dense, res } = await vectorStage(retrieval, query, userId, orgId, retrieveLimit)

  // ── signal 2: SPARSE (BM25) ──
  const bm25 = keywordStage(store, query, orgId, accessibleVids, retrieveLimit)

  // ── signal 3: GRAPH expansion (concept-connected chunks) ── CONTEXT_GRAPH=0 turns it off
  // (to measure what it adds on a given corpus; on by default).
  const graphOn = !/^(0|false|off)$/i.test(process.env.CONTEXT_GRAPH ?? "1")
  const graphList = graphOn ? await graphStage(graph, store, embeddings, query, orgId, dense, accMap) : []

  // ── signal 4 (opt-in): PPR multi-hop (HippoRAG-style walk from the query's entities) ──
  // The bounded hop above reaches 1 relation edge out; PPR reaches 2-3, bounded and
  // ACL-fail-closed. Off by default (measured on LoCoMo - see ppr-stage.ts); when the
  // flag is off this is [] and the pipeline is byte-identical to the pre-PPR one.
  const pprList = pprEnabled() ? await pprStage(graph, store, embeddings, query, orgId, dense, accMap) : []

  // ── Reciprocal Rank Fusion ──
  const K = Number(process.env.CONTEXT_RRF_K ?? 60)
  const merged = rrfFuse(dense, bm25, graphList, K, pprList)
  backfillMeta(store, merged, accMap)

  // ── optional PRF: a 2nd retrieval hop, LLM-free ──
  // Mine distinctive terms from the top of the first pass, expand the query with them, and
  // re-run dense+sparse. Folds items the raw query couldn't reach into the pool (the biggest
  // deterministic recall lever once the embedder is maxed out). Off by default (CONTEXT_PRF).
  if (/^(1|true|on)$/i.test(process.env.CONTEXT_PRF ?? "") && merged.length > 0) {
    const terms = expansionTerms(
      query,
      merged.slice(0, Number(process.env.CONTEXT_PRF_DOCS ?? 5)).map((m) => m.content),
      Number(process.env.CONTEXT_PRF_TERMS ?? 8),
    )
    if (terms.length) {
      const eq = `${query} ${terms.join(" ")}`
      const { dense: dense2 } = await vectorStage(retrieval, eq, userId, orgId, retrieveLimit)
      const bm2 = keywordStage(store, eq, orgId, accessibleVids, retrieveLimit)
      mergeFused(merged, rrfFuse(dense2, bm2, [], K))
      backfillMeta(store, merged, accMap)
    }
  }

  // ── sub-queries for compound questions (CONTEXT_SUBQUERIES=0 off) ──
  // "Which came first, the bike service or the car wash?" and "how long did 'A' and 'B' take
  // combined?" each need TWO different memories, but one query vector sits between them and finds
  // one. Search each alternative / quoted title on its own and fold it into the pool (like PRF).
  // LLM mode adds the model's rewrites of the question (CONTEXT_LLM_EXPAND=0 off) to the same pass.
  const expanded =
    opts.expansions ??
    (deps.expander && !/^(0|false|off)$/i.test(process.env.CONTEXT_LLM_EXPAND ?? "1") ? await deps.expander.expandQuery(query).catch(() => []) : [])
  if (!/^(0|false|off)$/i.test(process.env.CONTEXT_SUBQUERIES ?? "1") || expanded.length) {
    const sqs = /^(0|false|off)$/i.test(process.env.CONTEXT_SUBQUERIES ?? "1") ? expanded : [...subQueries(query), ...expanded]
    for (const sq of sqs) {
      const { dense: ds } = await vectorStage(retrieval, sq, userId, orgId, retrieveLimit)
      mergeFused(merged, rrfFuse(ds, keywordStage(store, sq, orgId, accessibleVids, retrieveLimit), [], K))
    }
    backfillMeta(store, merged, accMap)
  }

  // ── re-rank: personal boost + memory decay/salience (sorts merged) ──
  const cfg = decayConfig()
  decayStage(store, merged, userId, cfg)

  // ── time-aware boost: "a week ago", "last month", "most recently" vs each record's date ──
  timeStage(store, merged, query, now ?? Date.now())

  const ratio = Number(process.env.CONTEXT_RRF_RATIO ?? 0.3) // relative cutoff on fused score
  const initialCutoff = (merged[0]?.rrf ?? 0) * ratio

  // ── final stage: CROSS-ENCODER RERANK (optional) ──
  const { ordered, cutoff, rerankerUsed } = await rerankStage(reranker, query, merged, initialCutoff)

  // ── passage extraction + distinct-records-first diversity cap + topk (read-only) ──
  const relevant = diversityStage(ordered, query, cutoff, cfg.maxPerRecord, topk)

  // retrieval trace for the UI: counts per signal + which legs found each top item.
  if (trace) populateTrace(trace, dense, bm25, graphList, merged, ordered, rerankerUsed, pprList)

  return { ...res, searchResults: relevant }
}

/** The parts of a compound question that each point at a different memory: the alternatives of a
 *  trailing "..., A or B?" and quoted titles. Only a question with TWO OR MORE parts is split - a
 *  single quoted title is already in the main query, and searching it again on its own only
 *  re-weights it (measured: cost LoCoMo a question). [] for a simple question. At most 4. */
export function subQueries(query: string): string[] {
  const parts = questionParts(query)
  return parts.length >= 2 ? parts : []
}

function questionParts(query: string): string[] {
  const alt = /,\s*(?:the\s+)?([^,?]{3,100}?)\s+or\s+(?:the\s+)?([^,?]{3,100}?)\s*\??\s*$/i.exec(query)
  const alts = alt ? [alt[1], alt[2]].map((s) => s.replace(/['"“”‘’]/g, "").trim()) : []
  // a quote opens after a space/start (so the apostrophe in "What's" or "I've" isn't one)
  const quoted = [...query.matchAll(/(?:^|[\s(])['"“‘]([^'"”’]{3,80}?)['"”’](?=[\s,.?!)]|$)/g)]
    .map((m) => m[1].trim())
    .filter((q) => !alts.some((a) => a.includes(q)))
  return [...new Set([...alts, ...quoted].filter((s) => s.length >= 3))].slice(0, 4)
}

export type { SearchTrace } from "./trace"
