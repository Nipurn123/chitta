// Centrality - hub entities ranked by total edge weight (then degree). Pure over
// the scoped adjacency. "What are the central things I know about."

import { labelOf } from "./adjacency"
import type { Adj, Entity } from "./types"

/** Most-connected concepts in the accessible graph, heaviest total weight first. */
export function centralEntities(
  byId: Map<string, Entity>,
  adj: Map<string, Adj[]>,
  limit = 10,
): Array<{ label: string; degree: number; strength: number }> {
  const out: Array<{ label: string; degree: number; strength: number }> = []
  for (const [id, edges] of adj) {
    out.push({
      label: labelOf(id, byId),
      degree: edges.length,
      strength: edges.reduce((s, e) => s + e.weight, 0),
    })
  }
  out.sort((a, b) => b.strength - a.strength || b.degree - a.degree)
  return out.slice(0, limit)
}
