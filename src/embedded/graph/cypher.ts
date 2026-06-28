// Cypher export (Graphify's to_cypher) - render the already ACL-filtered subgraph
// as idempotent MERGE statements for Neo4j interop. Pure; ACL filtering happens
// upstream so this only ever sees what the user may access.

import type { Entity, Relation } from "./types"

export function toCypher(entities: Entity[], relations: Relation[], byId: Map<string, Entity>): string {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
  const lines: string[] = []
  for (const e of entities) lines.push(`MERGE (n:${e.type.replace(/[^A-Za-z0-9_]/g, "_") || "Entity"} {id:'${esc(e.id)}', label:'${esc(e.label)}'});`)
  for (const r of relations) {
    if (!byId.has(r.from) || !byId.has(r.to)) continue
    const rel = (r.type || "RELATES_TO").toUpperCase().replace(/[^A-Z0-9_]/g, "_")
    lines.push(`MATCH (a {id:'${esc(r.from)}'}),(b {id:'${esc(r.to)}'}) MERGE (a)-[:${rel} {weight:${r.weight}}]->(b);`)
  }
  return lines.join("\n")
}
