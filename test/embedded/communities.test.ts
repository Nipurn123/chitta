// Community detection via Label Propagation (LPA). The headline property, and the whole
// reason we replaced union-find: two DENSE clusters joined by a single BRIDGE edge must
// come back as TWO communities. Union-find (connected components) would fuse them into
// one blob the instant it saw the bridge, producing a useless "cluster of everything".
//
// These tests drive detectCommunities directly over a hand-built subgraph, so they are
// fully deterministic (no embedder, no provider, no RNG) and isolated from any other
// module. The adjacency builder below mirrors src/embedded/graph/adjacency.ts: every
// relation contributes an edge in BOTH directions (LPA votes over the undirected graph).

import { describe, expect, test } from "bun:test"
import { detectCommunities } from "../../src/embedded/graph/communities"
import type { Adj, Entity, Relation } from "../../src/embedded/graph/types"

const ent = (id: string): Entity => ({ id, label: id, type: "ORG" })

// Undirected weighted adjacency, matching buildAdjacency's shape (both endpoints list
// each other). Kept inline so this suite depends only on communities.ts + types.ts.
function build(entities: Entity[], relations: Relation[]): { byId: Map<string, Entity>; adj: Map<string, Adj[]> } {
  const byId = new Map(entities.map((e) => [e.id, e]))
  const adj = new Map<string, Adj[]>()
  const push = (a: string, e: Adj) => {
    const l = adj.get(a) ?? []
    l.push(e)
    adj.set(a, l)
  }
  for (const r of relations) {
    if (!byId.has(r.from) || !byId.has(r.to)) continue
    push(r.from, { to: r.to, type: r.type, weight: r.weight, dir: "out" })
    push(r.to, { to: r.from, type: r.type, weight: r.weight, dir: "in" })
  }
  return { byId, adj }
}

// Every distinct unordered pair inside `nodes` gets an edge -> a fully-connected clique
// (the densest possible cluster), so the internal majority is unambiguous.
function clique(nodes: string[], type: string, weight = 1): Relation[] {
  const rels: Relation[] = []
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) rels.push({ from: nodes[i], to: nodes[j], type, weight })
  return rels
}

const CLUSTER_A = ["acme_core", "acme_eng", "acme_hr", "acme_sales"]
const CLUSTER_B = ["globex_core", "globex_eng", "globex_hr", "globex_sales"]

// Two K4 cliques wired together by ONE edge. The bridge sits on non-minimal ids
// (acme_sales / globex_sales), i.e. each cluster's low-id members consolidate its label
// before the bridge endpoint votes - the realistic case, not the adversarial one where
// the bridge lands on both clusters' lexicographically-smallest node.
function twoClustersOneBridge(bridgeWeight = 1): { entities: Entity[]; relations: Relation[] } {
  const entities = [...CLUSTER_A, ...CLUSTER_B].map(ent)
  const relations = [
    ...clique(CLUSTER_A, "collaborates_with"),
    ...clique(CLUSTER_B, "collaborates_with"),
    { from: "acme_sales", to: "globex_sales", type: "partners_with", weight: bridgeWeight },
  ]
  return { entities, relations }
}

describe("communities (Label Propagation)", () => {
  test("splits two DENSE clusters joined by a single BRIDGE into TWO communities (union-find would merge)", () => {
    const { entities, relations } = twoClustersOneBridge()
    const { byId, adj } = build(entities, relations)

    const cs = detectCommunities(entities, relations, byId, adj, 2)

    // The crux: TWO communities, not one. Union-find over this graph returns exactly one
    // connected component (8 members) because the bridge makes everything reachable.
    expect(cs.length).toBe(2)

    const sets = cs.map((c) => new Set(c.members))
    const holdsCluster = (cluster: string[]) => sets.some((s) => s.size === cluster.length && cluster.every((m) => s.has(m)))
    // Each community is exactly one intact cluster - the bridge did NOT bleed members across.
    expect(holdsCluster(CLUSTER_A)).toBe(true)
    expect(holdsCluster(CLUSTER_B)).toBe(true)
    // No member appears in two communities (a clean partition).
    expect(cs.reduce((n, c) => n + c.members.length, 0)).toBe(8)
  })

  test("does NOT over-split a sparse chain - no bridge is weaker than its surroundings, so it stays ONE", () => {
    // a - b - c - d : a genuinely sparse path with no dense sub-structure. There is no
    // modular boundary to cut here, so LPA (like union-find) must keep it a single cluster.
    const entities = ["a", "b", "c", "d"].map(ent)
    const relations: Relation[] = [
      { from: "a", to: "b", type: "linked_to", weight: 1 },
      { from: "b", to: "c", type: "linked_to", weight: 1 },
      { from: "c", to: "d", type: "linked_to", weight: 1 },
    ]
    const { byId, adj } = build(entities, relations)

    const cs = detectCommunities(entities, relations, byId, adj, 2)
    expect(cs.length).toBe(1)
    expect(cs[0].members.slice().sort()).toEqual(["a", "b", "c", "d"])
  })

  test("weighted vote: a HEAVY bridge binds its two endpoints into ONE community (weight really matters)", () => {
    // The vote is by EDGE WEIGHT, not edge count. Prove it by contrast on the same topology:
    const together = (bridgeWeight: number): boolean => {
      const { entities, relations } = twoClustersOneBridge(bridgeWeight)
      const { byId, adj } = build(entities, relations)
      const cs = detectCommunities(entities, relations, byId, adj, 2)
      return cs.some((c) => c.members.includes("acme_sales") && c.members.includes("globex_sales"))
    }
    // A light bridge loses to each clique's 3 internal edges -> the endpoints stay in
    // their OWN clusters (different communities).
    expect(together(1)).toBe(false)
    // A bridge heavier than the internal edges wins the vote -> the two endpoints defect
    // together into a shared community. Same graph shape, opposite outcome: weight decided it.
    expect(together(1000)).toBe(true)
  })

  test("minSize drops singletons: an isolated node is not reported as a community", () => {
    const entities = ["x", "y", "loner"].map(ent)
    const relations: Relation[] = [{ from: "x", to: "y", type: "knows", weight: 1 }]
    const { byId, adj } = build(entities, relations)

    const cs = detectCommunities(entities, relations, byId, adj, 2)
    expect(cs.length).toBe(1)
    expect(cs[0].members.slice().sort()).toEqual(["x", "y"])
    expect(cs.some((c) => c.members.includes("loner"))).toBe(false)
  })

  test("empty graph yields no communities", () => {
    expect(detectCommunities([], [], new Map(), new Map(), 2)).toEqual([])
  })

  test("GraphRAG summary: names the hub, counts members, and surfaces the key predicate", () => {
    const { entities, relations } = twoClustersOneBridge()
    const { byId, adj } = build(entities, relations)
    const cs = detectCommunities(entities, relations, byId, adj, 2)

    const acme = cs.find((c) => c.members.includes("acme_core"))
    expect(acme).toBeDefined()
    // hub = most-connected member; the bridge endpoint acme_sales has degree 4 (3 clique + 1 bridge).
    expect(acme!.hub).toBe("acme_sales")
    expect(acme!.summary).toContain("a cluster of 4 related entities")
    expect(acme!.summary).toContain("key links:")
    expect(acme!.summary).toContain("collaborates with") // predicate, underscores humanized
  })

  test("deterministic: identical output across repeated runs (no RNG, fixed id order)", () => {
    const { entities, relations } = twoClustersOneBridge()
    const { byId, adj } = build(entities, relations)
    const a = detectCommunities(entities, relations, byId, adj, 2)
    const b = detectCommunities(entities, relations, byId, adj, 2)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})
