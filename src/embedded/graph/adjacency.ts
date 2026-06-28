// Adjacency / scope helpers - build the ACL-scoped subgraph and the small
// resolution utilities (free-text → entity ids, label lookup, hub threshold)
// that every traversal shares. Pure over the provider-returned {entities,
// relations}; the ACL filtering itself happens upstream in the provider.

import { slugify, entityId } from "../extract"
import type { Adj, Entity, Relation } from "./types"

/** Build id→entity map and the typed-first adjacency list from live relations.
 *  Edges whose endpoints aren't both present are dropped. Each adjacency list is
 *  ordered TYPED-first (generic "relates_to" last), then by descending weight, so
 *  neighbors lead with real relationships and BFS reconstructs precise predicates. */
export function buildAdjacency(
  entities: Entity[],
  relations: Relation[],
): { byId: Map<string, Entity>; adj: Map<string, Adj[]> } {
  const byId = new Map(entities.map((e) => [e.id, e]))
  const adj = new Map<string, Adj[]>()
  const push = (a: string, edge: Adj) => {
    const list = adj.get(a) ?? []
    list.push(edge)
    adj.set(a, list)
  }
  for (const r of relations) {
    if (!byId.has(r.from) || !byId.has(r.to)) continue
    push(r.from, { to: r.to, type: r.type, weight: r.weight, dir: "out" })
    push(r.to, { to: r.from, type: r.type, weight: r.weight, dir: "in" })
  }
  // Prefer TYPED edges over generic co-occurrence ("relates_to"): order each
  // adjacency list typed-first so neighbors lead with real relationships and BFS
  // paths are reconstructed through the precise predicate, not "relates_to".
  const generic = (t: string) => (t === "relates_to" ? 1 : 0)
  for (const list of adj.values()) list.sort((a, b) => generic(a.type) - generic(b.type) || b.weight - a.weight)
  return { byId, adj }
}

/** Resolve a free-text name to entity id(s) within the accessible set: exact id /
 *  exact label first, then substring/slug containment. Returns [] if unknown. */
export function resolveIds(name: string, entities: Entity[]): string[] {
  const q = name.trim().toLowerCase()
  if (!q) return []
  const slug = slugify(name)
  const id = entityId(slug)
  const exact = entities.filter((e) => e.id === id || e.label.toLowerCase() === q)
  if (exact.length) return [...new Set(exact.map((e) => e.id))]
  const partial = entities.filter((e) => e.label.toLowerCase().includes(q) || (slug.length >= 3 && e.id.includes(slug)))
  return [...new Set(partial.map((e) => e.id))]
}

export function labelOf(id: string, byId: Map<string, Entity>): string {
  return byId.get(id)?.label ?? id
}

/** hub threshold (Graphify _bfs): refuse to EXPAND through a super-connected node so
 *  one mega-entity can't blow up traversal / context. max(50, p99 degree). */
export function hubThreshold(adj: Map<string, Adj[]>): number {
  const degrees = [...adj.values()].map((l) => l.length).sort((a, b) => a - b)
  if (degrees.length === 0) return 50
  const p99 = degrees[Math.min(degrees.length - 1, Math.floor(degrees.length * 0.99))]
  return Math.max(50, p99)
}
