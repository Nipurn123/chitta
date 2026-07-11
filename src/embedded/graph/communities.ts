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
): Array<{ size: number; hub: string; members: string[]; summary: string }> {
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
  const out: Array<{ size: number; hub: string; members: string[]; summary: string }> = []
  for (const ids of groups.values()) {
    if (ids.length < minSize) continue
    const set = new Set(ids)
    const hubId = ids.reduce((best, id) => ((adj.get(id)?.length ?? 0) > (adj.get(best)?.length ?? 0) ? id : best), ids[0])
    const hub = labelOf(hubId, byId)
    // GraphRAG-style community SUMMARY: name the cluster by its hub, list its most-
    // connected members, and surface the predicates that hold it together - a compact,
    // human-readable description of what this part of the graph is ABOUT (deterministic).
    const members = ids
      .filter((id) => id !== hubId)
      .sort((a, b) => (adj.get(b)?.length ?? 0) - (adj.get(a)?.length ?? 0))
      .map((id) => labelOf(id, byId))
    const predCount = new Map<string, number>()
    for (const r of relations) {
      if (!set.has(r.from) || !set.has(r.to) || r.type === "relates_to") continue
      predCount.set(r.type, (predCount.get(r.type) ?? 0) + 1)
    }
    const topPreds = [...predCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t.replace(/_/g, " "))
    const shown = members.slice(0, 5)
    const more = members.length > shown.length ? `, +${members.length - shown.length} more` : ""
    const links = topPreds.length ? `; key links: ${topPreds.join(", ")}` : ""
    const summary = `${hub} — a cluster of ${ids.length} related entities (${[hub, ...shown].join(", ")}${more})${links}.`
    out.push({ size: ids.length, hub, members: ids.map((id) => labelOf(id, byId)), summary })
  }
  out.sort((a, b) => b.size - a.size)
  return out
}
