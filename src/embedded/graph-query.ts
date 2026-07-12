// Graph-query layer - turns the entity graph into something you can QUERY as a
// graph, not just semantically search. Ported from Graphify's serve.py query
// ergonomics (neighbors / shortest_path / impact / central) but, unlike Graphify:
//   • every traversal is ACL-FILTERED per caller (we only ever build the subgraph of
//     entities mentioned by records the user may access), and
//   • seeds are resolved against entity labels (and can be vector-seeded by the caller),
//     not Graphify's lexical IDF scoring.
// Pure in-memory traversal over the already-ACL-scoped {entities, relations} the
// provider returns - instant at personal/enterprise note scale, and ACL-safe by
// construction because the subgraph never contains an inaccessible entity.
//
// This file is the ORCHESTRATOR: scope() builds the ACL-scoped subgraph and each
// public method delegates to a pure algorithm module under ./graph/.

import { buildAdjacency, resolveIds } from "./graph/adjacency"
import { centralEntities } from "./graph/centrality"
import { detectCommunities } from "./graph/communities"
import { toCypher as renderCypher } from "./graph/cypher"
import { connectedEntities } from "./graph/impact"
import { personalizedPageRank } from "./graph/pagerank"
import { neighborsOf, shortestPath } from "./graph/traversal"
import type { ScopedGraph } from "./graph/types"
import type { SqliteGraphProvider } from "./sqlite-graph-provider"

export interface NeighborResult {
  entity: string
  neighbors: Array<{ label: string; relation: string; direction: "out" | "in"; weight: number }>
}
export interface PathResult {
  found: boolean
  hops: number
  steps: Array<{ from: string; relation: string; to: string }>
}
export interface ImpactResult {
  entity: string
  records: string[]
  connectedEntities: Array<{ label: string; relation: string }>
}
/** One typed assertion of a principal's belief set, rendered readable. */
export interface Belief {
  from: string
  type: string
  to: string
}
export interface BeliefDiffResult {
  /** Typed beliefs A can see that B cannot. */
  aOnly: Belief[]
  /** Typed beliefs B can see that A cannot. */
  bOnly: Belief[]
}

export class GraphQueryService {
  constructor(private readonly graph: SqliteGraphProvider) {}

  // The ACL-scoped subgraph: entities + LIVE relations the user may see. Everything
  // below traverses ONLY this, so no query can reach across a permission boundary.
  private async scope(userId: string, orgId: string): Promise<ScopedGraph> {
    const accessible = await this.graph.getAccessibleVirtualRecordIds({ userId, orgId })
    const recordIds = [...new Set(Object.values(accessible))]
    const { entities, relations } = this.graph.getKnowledgeGraph(recordIds)
    const { byId, adj } = buildAdjacency(entities, relations)
    return { entities, relations, byId, adj, recordIds }
  }

  /** Direct neighbors of an entity, optionally filtered by relation, heaviest first. */
  async neighbors(name: string, userId: string, orgId: string, relation?: string): Promise<NeighborResult | null> {
    const { entities, byId, adj } = await this.scope(userId, orgId)
    const ids = resolveIds(name, entities)
    if (ids.length === 0) return null
    return neighborsOf(ids, byId, adj, relation)
  }

  /** Entity-centric recall for a FREE-TEXT query ("everything about Elon Musk"):
   *  resolve the entity NAMED in the question (its label occurs in the text), anchor on
   *  the most specific match plus its aliases, and return the full typed neighborhood -
   *  the same 100%-complete edge set as neighbors(), but driven by natural language
   *  instead of an exact entity name. Powers get_context's graph-facts section, which is
   *  what closes the gap between ranked retrieval (lossy) and the typed graph (complete). */
  async neighborsForQuery(query: string, userId: string, orgId: string, limit = 40): Promise<NeighborResult | null> {
    const { entities, byId, adj } = await this.scope(userId, orgId)
    if (entities.length === 0) return null
    const q = query.toLowerCase()
    // entities literally named in the query, most specific (longest label) first
    const named = entities
      .filter((e) => e.label.length >= 3 && q.includes(e.label.toLowerCase()))
      .sort((a, b) => b.label.length - a.label.length)
    if (named.length === 0) return null
    // anchor on the most specific named entity + any alias/fragment of it that also
    // matched (e.g. "Elon Musk" + "Musk"), so fragmented references are unified.
    const topL = named[0].label.toLowerCase()
    const ids = named
      .filter((e) => {
        const l = e.label.toLowerCase()
        return l === topL || topL.includes(l) || l.includes(topL)
      })
      .map((e) => e.id)
    const result = neighborsOf([...new Set(ids)], byId, adj)
    result.neighbors = result.neighbors.slice(0, limit)
    return result
  }

  /** Shortest relation chain between two entities (undirected BFS, hub-avoiding).
   *  Answers "how are X and Y related?" - the single most useful graph query. */
  async pathBetween(a: string, b: string, userId: string, orgId: string): Promise<PathResult> {
    const { entities, byId, adj } = await this.scope(userId, orgId)
    const startIds = resolveIds(a, entities)
    const goalIds = new Set(resolveIds(b, entities))
    return shortestPath(startIds, goalIds, byId, adj)
  }

  /** Impact / reverse-reference: which accessible records mention the entity, and
   *  which entities it connects to. "What references / depends on X." */
  async impactOf(name: string, userId: string, orgId: string): Promise<ImpactResult | null> {
    const { entities, byId, adj, recordIds } = await this.scope(userId, orgId)
    const ids = resolveIds(name, entities)
    if (ids.length === 0) return null
    const records = new Set<string>()
    for (const name2 of this.graph.recordsMentioning(ids, recordIds)) records.add(name2)
    const connected = connectedEntities(ids, byId, adj)
    return { entity: byId.get(ids[0])?.label ?? ids[0], records: [...records], connectedEntities: connected }
  }

  /** Hub entities - highest total edge weight (most-connected concepts) in the
   *  accessible graph. "What are the central things I know about." */
  async central(userId: string, orgId: string, limit = 10): Promise<Array<{ label: string; degree: number; strength: number }>> {
    const { byId, adj } = await this.scope(userId, orgId)
    return centralEntities(byId, adj, limit)
  }

  /** Personalized PageRank multi-hop walk (HippoRAG-style). Seeds activation mass on
   *  the query's entities and spreads it over the ACL-scoped, weighted typed graph;
   *  a node reachable via MANY paths scores higher than a near dead-end. This is true
   *  multi-hop relevance - strictly better than fixed-depth neighbor expansion - and
   *  it's pure TS power-iteration (sub-ms at our scale). Returns ranked related
   *  entities (seeds excluded). Edge weight (frequency≈confidence) steers the flow. */
  async walk(
    seedNames: string[],
    userId: string,
    orgId: string,
    opts: { alpha?: number; iters?: number; limit?: number } = {},
  ): Promise<Array<{ label: string; score: number; type: string }>> {
    const alpha = opts.alpha ?? 0.85
    const iters = opts.iters ?? 30
    const limit = opts.limit ?? 15
    const { entities, byId, adj } = await this.scope(userId, orgId)
    if (entities.length === 0) return []
    const seedIds = new Set<string>()
    for (const name of seedNames) for (const id of resolveIds(name, entities)) seedIds.add(id)
    if (seedIds.size === 0) return []
    return personalizedPageRank(entities, byId, adj, seedIds, { alpha, iters, limit })
  }

  /** Communities - cohesive clusters of related entities (Graphify's god-node /
   *  community view), via label propagation over live edges (recovers modular structure
   *  inside one connected component). Each cluster's `hub` is its most-connected member,
   *  with a GraphRAG-style summary. ACL-scoped. */
  async communities(userId: string, orgId: string, minSize = 2): Promise<Array<{ size: number; hub: string; members: string[]; summary: string }>> {
    const { entities, relations, byId, adj } = await this.scope(userId, orgId)
    return detectCommunities(entities, relations, byId, adj, minSize)
  }

  /** Export the accessible graph as Cypher (Neo4j interop) - Graphify's to_cypher,
   *  but ACL-filtered to exactly what this user may see. Uses MERGE so it's idempotent. */
  async toCypher(userId: string, orgId: string): Promise<string> {
    const { entities, relations, byId } = await this.scope(userId, orgId)
    return renderCypher(entities, relations, byId)
  }

  // ── PERSPECTIVES - compare what different principals can see over the SAME graph ──

  // A principal's BELIEF SET: every live typed relation in their ACL-scoped subgraph,
  // keyed by entity ids (stable identity) and rendered with labels. Symmetric
  // "relates_to" co-occurrence is excluded - graph signal, not an asserted fact (the
  // same line the memory layer draws at consolidation). The ACL invariant is inherited
  // from scope(): its per-edge provenance guard means a relation is in the set ONLY if
  // a record this principal may access asserted it - endpoint visibility is not enough.
  private beliefSet(g: ScopedGraph): Map<string, Belief> {
    const label = (id: string) => g.byId.get(id)?.label ?? id
    const set = new Map<string, Belief>()
    for (const r of g.relations) {
      if (r.type === "relates_to") continue
      set.set(`${r.from}|${r.type}|${r.to}`, { from: label(r.from), type: r.type, to: label(r.to) })
    }
    return set
  }

  /** PERSPECTIVE DIFF - the typed beliefs principal A can see that B cannot (`aOnly`),
   *  and vice versa (`bOnly`). Each side is that principal's OWN ACL scope, so a private
   *  fact shows up exactly once, on its owner's side. "What does the planner know that
   *  the critic doesn't" - the query that makes multi-agent memory inspectable. */
  async beliefDiff(principalA: string, principalB: string, orgId: string): Promise<BeliefDiffResult> {
    const [a, b] = await Promise.all([this.scope(principalA, orgId), this.scope(principalB, orgId)])
    const setA = this.beliefSet(a)
    const setB = this.beliefSet(b)
    return {
      aOnly: [...setA].filter(([k]) => !setB.has(k)).map(([, v]) => v),
      bOnly: [...setB].filter(([k]) => !setA.has(k)).map(([, v]) => v),
    }
  }

  /** SHARED BELIEFS - the typed relations EVERY listed principal can see (the
   *  intersection of their ACL-scoped belief sets): an agent team's common ground. */
  async sharedBeliefs(principals: string[], orgId: string): Promise<Belief[]> {
    if (principals.length === 0) return []
    const sets = await Promise.all(principals.map(async (p) => this.beliefSet(await this.scope(p, orgId))))
    const [first, ...rest] = sets
    return [...first].filter(([k]) => rest.every((s) => s.has(k))).map(([, v]) => v)
  }
}
