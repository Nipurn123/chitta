// Communities - connected clusters of related entities (Graphify's god-node /
// community view), via union-find over live edges. Each cluster's `hub` is its
// most-connected member. Pure over the scoped subgraph (ACL-scoped upstream).

import { labelOf } from "./adjacency"
import type { Adj, Entity, Relation } from "./types"

export function detectCommunities(
  entities: Entity[],
  relations: Relation[],
  byId: Map<string, Entity>,
  adj: Map<string, Adj[]>,
  minSize = 2,
): Array<{ size: number; hub: string; members: string[] }> {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r) as string
    while (parent.get(x) !== r) {
      const n = parent.get(x) as string
      parent.set(x, r)
      x = n
    }
    return r
  }
  for (const e of entities) parent.set(e.id, e.id)
  for (const r of relations) {
    if (!parent.has(r.from) || !parent.has(r.to)) continue
    parent.set(find(r.from), find(r.to))
  }
  const groups = new Map<string, string[]>()
  for (const e of entities) {
    const root = find(e.id)
    const g = groups.get(root) ?? []
    g.push(e.id)
    groups.set(root, g)
  }
  const out: Array<{ size: number; hub: string; members: string[] }> = []
  for (const ids of groups.values()) {
    if (ids.length < minSize) continue
    const hub = ids.reduce((best, id) => ((adj.get(id)?.length ?? 0) > (adj.get(best)?.length ?? 0) ? id : best), ids[0])
    out.push({ size: ids.length, hub: labelOf(hub, byId), members: ids.map((id) => labelOf(id, byId)) })
  }
  out.sort((a, b) => b.size - a.size)
  return out
}
