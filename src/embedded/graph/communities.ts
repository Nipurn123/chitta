// Communities - cohesive clusters of related entities (Graphify's god-node /
// community view), the substrate for GraphRAG-style community summaries. Detected
// with LABEL PROPAGATION (LPA), NOT union-find. WHY the change: union-find returns
// CONNECTED COMPONENTS, so any densely-wired graph - where almost everything is
// transitively reachable from everything else - collapses into ONE giant "community"
// whose summary ("a cluster of 900 entities…") is useless. LPA instead recovers the
// MODULAR structure inside a single connected component: two tightly-knit groups joined
// by a lone bridge edge stay SEPARATE, because each group's internal majority label
// out-votes the single cross-edge. That yields several small, meaningful communities
// instead of one blob, while still merging genuinely sparse chains (no bridge is weaker
// than the links around it) into one - i.e. it only splits where real structure exists.
//
// Determinism (required - canonical LPA breaks ties RANDOMLY and shuffles node order;
// we must be reproducible so tests can pin exact clusters):
//   • seed every node's label with its own id (like union-find's MakeSet);
//   • process nodes in a FIXED order (ascending id) and update labels IN PLACE. This is
//     ASYNCHRONOUS LPA: it converges, whereas SYNCHRONOUS LPA (all nodes read the prior
//     round) oscillates forever on bipartite/tree graphs and would never stabilize;
//   • each node adopts the label carrying the greatest total EDGE WEIGHT among its
//     neighbors (weight ≈ co-occurrence/confidence), ties broken by the smallest label
//     id - so the result depends ONLY on the graph, never on Map/insertion order;
//   • sweep at most MAX_PASSES times, stopping the instant a full sweep changes nothing
//     (a fixed point). The cap only bounds pathological inputs; it never runs long.
// Each cluster's `hub` is its most-connected member. Pure over the scoped subgraph
// (ACL-scoped upstream).

import { labelOf } from "./adjacency"
import type { Adj, Entity, Relation } from "./types"

// A handful of sweeps is plenty: LPA propagates labels one hop per pass and real
// communities have small diameter, so labels settle fast. The cap only guarantees
// termination if some adversarial graph never reaches a fixed point.
const MAX_PASSES = 10

export function detectCommunities(
  entities: Entity[],
  relations: Relation[],
  byId: Map<string, Entity>,
  adj: Map<string, Adj[]>,
  minSize = 2,
): Array<{ size: number; hub: string; members: string[]; summary: string }> {
  // Fixed, id-sorted processing order: the SAME order every run is what makes the whole
  // algorithm deterministic despite LPA's usual reliance on a random node permutation.
  const order = entities.map((e) => e.id).sort()
  // Seed: every node starts in its own community (label = own id). From here labels FLOW
  // along edges toward whichever community pulls hardest, instead of being merged blindly
  // on first contact (union-find's flaw - one edge is enough to fuse two whole components).
  const label = new Map<string, string>()
  for (const id of order) label.set(id, id)

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false
    for (const id of order) {
      const nbrs = adj.get(id)
      if (!nbrs || nbrs.length === 0) continue // isolated node keeps its own (singleton) label
      // Weighted vote: sum edge weight per neighbor label, so a heavier (more frequently
      // co-occurring) relationship pulls harder. This is exactly what lets a dense cluster's
      // internal majority (many edges) out-vote a single weak bridge edge to another cluster.
      const tally = new Map<string, number>()
      for (const e of nbrs) {
        const l = label.get(e.to)
        if (l === undefined) continue // neighbor outside scope (defensive; buildAdjacency prevents it)
        tally.set(l, (tally.get(l) ?? 0) + e.weight)
      }
      // Adopt the max-weight neighbor label; ties -> smallest label id (deterministic).
      let best: string | undefined
      let bestW = 0
      for (const [l, w] of tally) {
        if (best === undefined || w > bestW || (w === bestW && l < best)) {
          best = l
          bestW = w
        }
      }
      if (best !== undefined && best !== label.get(id)) {
        label.set(id, best)
        changed = true
      }
    }
    if (!changed) break // fixed point reached - no later sweep could change anything
  }

  // Each distinct surviving label is one community; gather its members.
  const groups = new Map<string, string[]>()
  for (const id of order) {
    const l = label.get(id) as string
    const g = groups.get(l) ?? []
    g.push(id)
    groups.set(l, g)
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
    const summary = `${hub} - a cluster of ${ids.length} related entities (${[hub, ...shown].join(", ")}${more})${links}.`
    out.push({ size: ids.length, hub, members: ids.map((id) => labelOf(id, byId)), summary })
  }
  // Largest communities first; ties broken by hub label so equal-size clusters (which LPA
  // routinely produces) always come back in the same, stable, deterministic order.
  out.sort((a, b) => b.size - a.size || a.hub.localeCompare(b.hub))
  return out
}
