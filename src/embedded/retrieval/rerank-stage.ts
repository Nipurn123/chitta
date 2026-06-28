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
      cand.forEach((c, i) => (c.rrf = scores[i]))
      cand.sort((a, b) => b.rrf - a.rrf)
      ordered = [...cand, ...merged.slice(rerankK)]
      cutoff = -Infinity // reranker decided relevance; keep its order, no rrf cutoff
      rerankerUsed = true
    }
  }
  return { ordered, cutoff, rerankerUsed }
}
