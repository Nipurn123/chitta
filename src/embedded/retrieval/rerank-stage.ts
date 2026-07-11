// Final stage: CROSS-ENCODER RERANK (optional).
// RRF maximizes recall; the cross-encoder fixes ORDERING by jointly scoring
// (query, passage). Rerank only the top-K candidates (cost is linear), reorder, and
// drop the rrf-relative cutoff (rerank logits aren't on the rrf scale).
import type { Reranker } from "../reranker"
import type { FusedResult } from "./fuse"
import { bestPassage, queryTokens } from "./passage"

export async function rerankStage(
  reranker: Reranker | undefined,
  query: string,
  merged: FusedResult[],
  initialCutoff: number,
): Promise<{ ordered: FusedResult[]; cutoff: number; rerankerUsed: boolean }> {
  let ordered = merged
  let cutoff = initialCutoff
  let rerankerUsed = false
  if (reranker && merged.length > 1) {
    const rerankK = Number(process.env.CONTEXT_RERANK_K ?? 20)
    const cand = merged.slice(0, rerankK)
    const scores = await reranker.rank(query, cand.map((c) => bestPassage(c.content, queryTokens(query)) || c.content))
    if (scores) {
      // Default: the cross-encoder decides the order outright (highest precision when the
      // model is confident). BLEND (opt-in): rank-fuse the reranker's order with the existing
      // RRF order, so a candidate strong in RRF that the cross-encoder MIS-scores isn't fully
      // demoted out of the top-k - preserves recall@k while keeping most of the ranking gain
      // (the cross-encoder can hurt recall on out-of-domain/short passages otherwise).
      if (/^(1|true|on)$/i.test(process.env.CONTEXT_RERANK_BLEND ?? "")) {
        const K = Number(process.env.CONTEXT_RRF_K ?? 60)
        const rerankRank = new Map<number, number>() // candidate index → its position by rerank score
        ;[...cand.keys()].sort((a, b) => scores[b] - scores[a]).forEach((idx, pos) => rerankRank.set(idx, pos))
        cand.forEach((c, i) => (c.rrf = 1 / (K + i) + 1 / (K + (rerankRank.get(i) ?? rerankK)))) // i = RRF rank
      } else {
        cand.forEach((c, i) => (c.rrf = scores[i]))
      }
      cand.sort((a, b) => b.rrf - a.rrf)
      ordered = [...cand, ...merged.slice(rerankK)]
      cutoff = -Infinity // reranker decided relevance; keep its order, no rrf cutoff
      rerankerUsed = true
    }
  }
  return { ordered, cutoff, rerankerUsed }
}
