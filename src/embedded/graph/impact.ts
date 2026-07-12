// Impact / reverse-reference - given resolved entity ids, the directly connected
// entities. The "which records mention it" half lives in the provider
// (recordsMentioning); the orchestrator joins the two. Pure over the scoped adj.

import type { ImpactResult } from "../graph-query"
import { labelOf } from "./adjacency"
import type { Adj, Entity } from "./types"

/** The distinct entities the given ids connect to (first edge wins per neighbor). */
export function connectedEntities(
  ids: string[],
  byId: Map<string, Entity>,
  adj: Map<string, Adj[]>,
): ImpactResult["connectedEntities"] {
  const connected: ImpactResult["connectedEntities"] = []
  const seen = new Set<string>()
  for (const id of ids)
    for (const e of adj.get(id) ?? []) {
      if (seen.has(e.to)) continue
      seen.add(e.to)
      connected.push({ label: labelOf(e.to, byId), relation: e.type })
    }
  return connected
}
