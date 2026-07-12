// Entity linking - resolve a mention from parsed intent to a graph entity id,
// by slug first then exact label match.

import { slugify, entityId } from "../extract"
import type { Graph } from "./types"

export function link(mention: string, g: Graph): string | null {
  const id = entityId(slugify(mention))
  if (g.entities.some((e) => e.id === id)) return id
  const m = mention.toLowerCase()
  const byLabel = g.entities.find((e) => e.label.toLowerCase() === m)
  return byLabel?.id ?? null
}
