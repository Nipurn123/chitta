// Retrieval metrics - pure functions over a ranked list of ids + the gold-relevant
// set. No LLM, deterministic, repeatable: this is what replaces "tuning by eyeballing".
// Track recall@k (did the right item come back?) + nDCG@k (is it ranked well?) as the
// two headline numbers, per the 2026 RAG-eval consensus.

/** Fraction of gold items present in the top-k ranked list. */
export function recallAtK(ranked: string[], gold: Set<string>, k: number): number {
  if (gold.size === 0) return 1
  const top = ranked.slice(0, k)
  let hit = 0
  for (const g of gold) if (top.includes(g)) hit++
  return hit / gold.size
}

/** Fraction of the top-k that are gold-relevant. */
export function precisionAtK(ranked: string[], gold: Set<string>, k: number): number {
  const top = ranked.slice(0, k)
  if (top.length === 0) return 0
  return top.filter((id) => gold.has(id)).length / top.length
}

/** Mean reciprocal rank: 1 / (rank of first gold hit), else 0. */
export function reciprocalRank(ranked: string[], gold: Set<string>): number {
  for (let i = 0; i < ranked.length; i++) if (gold.has(ranked[i])) return 1 / (i + 1)
  return 0
}

/** nDCG@k with optional graded relevance (default binary). Rank-aware. */
export function ndcgAtK(ranked: string[], gold: Set<string>, k: number, grades?: Map<string, number>): number {
  const rel = (id: string) => (grades ? grades.get(id) ?? 0 : gold.has(id) ? 1 : 0)
  let dcg = 0
  for (let i = 0; i < Math.min(k, ranked.length); i++) dcg += (2 ** rel(ranked[i]) - 1) / Math.log2(i + 2)
  // ideal DCG: sort all known-relevant grades descending
  const ideal = [...(grades ? grades.values() : [...gold].map(() => 1))].sort((a, b) => b - a).slice(0, k)
  let idcg = 0
  for (let i = 0; i < ideal.length; i++) idcg += (2 ** ideal[i] - 1) / Math.log2(i + 2)
  return idcg === 0 ? 0 : dcg / idcg
}
