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
    // Candidates = the best-ranked chunk of each of the top CONTEXT_RERANK_K records (default 50).
    // One per record because the final list keeps one chunk per record first (diversity.ts):
    // scoring a record's 2nd/3rd chunk spends cross-encoder calls on slots it can't win. On pooled
    // LongMemEval the blended reranker over 50 candidates added 3.8 points all-gold@10 over no
    // reranker (66.6% → 70.4%); it costs ~0.5 s/query on a CPU VM - lower K trades accuracy for
    // latency.
    const rerankK = Number(process.env.CONTEXT_RERANK_K ?? 50)
    const cand: FusedResult[] = []
    const rest: FusedResult[] = []
    const seen = new Set<string>()
    for (const c of merged) {
      const rec = (c.metadata.recordId ?? c.metadata.virtualRecordId) as string | undefined
      if (cand.length < rerankK && !(rec && seen.has(rec))) {
        if (rec) seen.add(rec)
        cand.push(c)
      } else rest.push(c)
    }
    const scores = await reranker.rank(query, cand.map((c) => bestPassage(c.content, queryTokens(query)) || c.content))
    if (scores) {
      // Default: BLEND - rank-fuse the reranker's order with the existing RRF order, so a
      // candidate strong in RRF that the cross-encoder MIS-scores isn't fully demoted out of the
      // top-k (the cross-encoder can hurt recall on out-of-domain/short passages). Measured best
      // recall on pooled LongMemEval (70.4% vs 69.6% for pure rerank). CONTEXT_RERANK_BLEND=0
      // lets the cross-encoder decide the order outright (best MRR when the model is confident).
      if (!/^(0|false|off)$/i.test(process.env.CONTEXT_RERANK_BLEND ?? "1")) {
        const K = Number(process.env.CONTEXT_RRF_K ?? 60)
        const rerankRank = new Map<number, number>() // candidate index → its position by rerank score
        ;[...cand.keys()].sort((a, b) => scores[b] - scores[a]).forEach((idx, pos) => rerankRank.set(idx, pos))
        cand.forEach((c, i) => (c.rrf = 1 / (K + i) + 1 / (K + (rerankRank.get(i) ?? rerankK)))) // i = RRF rank
      } else {
        cand.forEach((c, i) => (c.rrf = scores[i]))
      }
      cand.sort((a, b) => b.rrf - a.rrf)
      ordered = [...cand, ...rest]
      cutoff = -Infinity // reranker decided relevance; keep its order, no rrf cutoff
      rerankerUsed = true
    }
  }
  return { ordered, cutoff, rerankerUsed }
}
