// Traversal - direct neighbors and shortest relation chains (undirected,
// hub-avoiding BFS). Pure over the scoped subgraph; results are labeled by the
// caller-provided byId map. ACL-safe by construction (the subgraph already
// excludes inaccessible entities/edges).

import type { NeighborResult, PathResult } from "../graph-query"
import { hubThreshold, labelOf } from "./adjacency"
import type { Adj, Entity } from "./types"

/** Direct neighbors of the resolved entity ids, optionally filtered by relation,
 *  typed-relationships-first then heaviest first. */
export function neighborsOf(
  ids: string[],
  byId: Map<string, Entity>,
  adj: Map<string, Adj[]>,
  relation?: string,
): NeighborResult {
  const seen = new Set<string>()
  const neighbors: NeighborResult["neighbors"] = []
  for (const id of ids) {
    for (const e of adj.get(id) ?? []) {
      if (relation && e.type !== relation) continue
      const key = `${e.to}|${e.type}|${e.dir}`
      if (seen.has(key)) continue
      seen.add(key)
      neighbors.push({ label: labelOf(e.to, byId), relation: e.type, direction: e.dir, weight: e.weight })
    }
  }
  // Typed relationships first, then by weight - so real predicates lead over "relates_to".
  neighbors.sort((a, b) => (a.relation === "relates_to" ? 1 : 0) - (b.relation === "relates_to" ? 1 : 0) || b.weight - a.weight)
  return { entity: labelOf(ids[0], byId), neighbors }
}

/** Shortest relation chain between two id sets (undirected BFS, hub-avoiding).
 *  Answers "how are X and Y related?" - the single most useful graph query. */
export function shortestPath(
  startIds: string[],
  goalIds: Set<string>,
  byId: Map<string, Entity>,
  adj: Map<string, Adj[]>,
): PathResult {
  if (startIds.length === 0 || goalIds.size === 0) return { found: false, hops: 0, steps: [] }
  const hub = hubThreshold(adj)
  const prev = new Map<string, { from: string; type: string }>()
  const queue: string[] = [...startIds]
  const visited = new Set<string>(startIds)
  let hitGoal: string | null = null
  while (queue.length) {
    const cur = queue.shift() as string
    if (goalIds.has(cur)) {
      hitGoal = cur
      break
    }
    // don't EXPAND through a hub (but it can still be a goal, handled above)
    if ((adj.get(cur)?.length ?? 0) > hub && !startIds.includes(cur)) continue
    for (const e of adj.get(cur) ?? []) {
      if (visited.has(e.to)) continue
      visited.add(e.to)
      prev.set(e.to, { from: cur, type: e.type })
      queue.push(e.to)
    }
  }
  if (!hitGoal) return { found: false, hops: 0, steps: [] }
  // reconstruct
  const chain: Array<{ from: string; relation: string; to: string }> = []
  let node = hitGoal
  while (prev.has(node)) {
    const p = prev.get(node) as { from: string; type: string }
    chain.unshift({ from: labelOf(p.from, byId), relation: p.type, to: labelOf(node, byId) })
    node = p.from
  }
  return { found: true, hops: chain.length, steps: chain }
}
