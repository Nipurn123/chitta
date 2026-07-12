// Eval harness - runs a gold Q→relevant-id set through any retrieval function and
// reports aggregate metrics, so every retrieval change is MEASURED, not eyeballed.
// The gold set is meant to be auto-synthesized from your OWN corpus/graph (the
// frontier model that calls the MCP generates questions whose source record id IS the
// gold label; 2-hop graph walks give multi-hop gold pairs). Here we keep the harness
// retrieval-agnostic - pass any `retrieve(query) → ranked ids`.

import { recallAtK, precisionAtK, reciprocalRank, ndcgAtK } from "./metrics"

export interface GoldItem {
  query: string
  /** Ids that SHOULD be retrieved (record ids by default). */
  gold: string[]
  /** Optional graded relevance per id (0..3) for nDCG. */
  grades?: Record<string, number>
}

export interface EvalReport {
  n: number
  k: number
  recall: number
  ndcg: number
  mrr: number
  precision: number
  perQuery: Array<{ query: string; recall: number; precision: number; ndcg: number; rr: number; missed: boolean }>
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

/** Run the gold set through `retrieve` and aggregate recall@k / nDCG@k / MRR / P@k. */
export async function evaluate(
  gold: GoldItem[],
  retrieve: (query: string) => Promise<string[]>,
  k = 10,
): Promise<EvalReport> {
  const per: EvalReport["perQuery"] = []
  for (const item of gold) {
    // dedupe the ranked ids (a record can yield several chunks/passages) - record-level
    // metrics care about each record's FIRST position, so dupes must not double-count.
    const seen = new Set<string>()
    const ranked = (await retrieve(item.query)).filter((id) => (seen.has(id) ? false : (seen.add(id), true)))
    const goldSet = new Set(item.gold)
    const grades = item.grades ? new Map(Object.entries(item.grades)) : undefined
    const recall = recallAtK(ranked, goldSet, k)
    const precision = precisionAtK(ranked, goldSet, k)
    const ndcg = ndcgAtK(ranked, goldSet, k, grades)
    const rr = reciprocalRank(ranked, goldSet)
    per.push({ query: item.query, recall, precision, ndcg, rr, missed: recall === 0 })
  }
  return {
    n: gold.length,
    k,
    recall: mean(per.map((p) => p.recall)),
    ndcg: mean(per.map((p) => p.ndcg)),
    mrr: mean(per.map((p) => p.rr)),
    precision: mean(per.map((p) => p.precision)),
    perQuery: per,
  }
}

/** Pretty one-line summary for CLI/CI diffing against a baseline. */
export function formatReport(r: EvalReport): string {
  const missed = r.perQuery.filter((p) => p.missed).length
  return `eval n=${r.n} k=${r.k} | recall@${r.k}=${r.recall.toFixed(3)} nDCG@${r.k}=${r.ndcg.toFixed(3)} MRR=${r.mrr.toFixed(3)} | misses=${missed}`
}
