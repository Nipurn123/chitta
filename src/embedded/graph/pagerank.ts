// Personalized PageRank multi-hop walk (HippoRAG-style). Seeds activation mass on
// the query's entities and spreads it over the ACL-scoped, weighted typed graph;
// a node reachable via MANY paths scores higher than a near dead-end. Pure TS
// power-iteration (sub-ms at our scale). Returns ranked related entities (seeds
// excluded). Edge weight (frequency≈confidence) steers the flow.

import type { Adj, Entity } from "./types"

export function personalizedPageRank(
  entities: Entity[],
  byId: Map<string, Entity>,
  adj: Map<string, Adj[]>,
  seedIds: Set<string>,
  opts: { alpha: number; iters: number; limit: number },
): Array<{ label: string; score: number; type: string }> {
  const { alpha, iters, limit } = opts
  if (entities.length === 0) return []
  if (seedIds.size === 0) return []

  const ids = entities.map((e) => e.id)
  const n = ids.length
  const idx = new Map(ids.map((id, i) => [id, i]))
  // weighted out-degree (undirected: adj holds both directions)
  const deg = new Float64Array(n)
  for (const id of ids) {
    let d = 0
    for (const e of adj.get(id) ?? []) d += e.weight
    deg[idx.get(id) as number] = d || 1
  }
  // personalization vector: mass on the seeds
  const teleport = new Float64Array(n)
  for (const s of seedIds) {
    const i = idx.get(s)
    if (i !== undefined) teleport[i] = 1 / seedIds.size
  }
  let r = Float64Array.from(teleport)
  for (let it = 0; it < iters; it++) {
    const next = new Float64Array(n)
    for (let i = 0; i < n; i++) next[i] = (1 - alpha) * teleport[i] // restart to seeds
    for (const id of ids) {
      const i = idx.get(id) as number
      if (r[i] === 0) continue
      const share = (alpha * r[i]) / deg[i]
      for (const e of adj.get(id) ?? []) {
        const j = idx.get(e.to)
        if (j !== undefined) next[j] += share * e.weight
      }
    }
    r = next
  }
  return ids
    .map((id, i) => ({ id, label: byId.get(id)?.label ?? id, type: byId.get(id)?.type ?? "", score: r[i] }))
    .filter((x) => !seedIds.has(x.id) && x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ label, score, type }) => ({ label, score, type }))
}
