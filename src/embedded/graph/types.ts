// Shared in-memory graph shapes used across the decomposed graph-query modules.
// These mirror the structures GraphQueryService builds from the provider's
// ACL-scoped {entities, relations}; kept here so the pure-function modules can
// be typed without depending on the orchestrating class.

export interface Entity {
  id: string
  label: string
  type: string
}

export interface Relation {
  from: string
  to: string
  type: string
  weight: number
}

export interface Adj {
  to: string
  type: string
  weight: number
  dir: "out" | "in"
}

/** The ACL-scoped subgraph: entities + LIVE relations the user may see, plus the
 *  derived id→entity map, adjacency, and the accessible record id set. Every
 *  traversal works ONLY over this, so no query crosses a permission boundary. */
export interface ScopedGraph {
  entities: Entity[]
  relations: Relation[]
  byId: Map<string, Entity>
  adj: Map<string, Adj[]>
  recordIds: string[]
}
