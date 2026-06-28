import type { ContextBackend } from "../backend"
import type { ToolModule, ToolResult } from "./types"

const schema = {
  name: "context_relate",
  description:
    "Query the knowledge graph AS A GRAPH (not text search). Four modes:\n" +
    "• neighbors - what's directly connected to an entity (optionally by relation).\n" +
    "• path - HOW two entities are related (shortest relation chain between them).\n" +
    "• impact - which records reference an entity + what it connects to ('what depends on X').\n" +
    "• central - the hub entities (most-connected concepts the user knows about).\n" +
    "• communities - clusters of related entities (the natural groupings in the graph).\n" +
    "• walk - multi-hop relevance (Personalized PageRank) from one or more seed entities: what's\n" +
    "  most related across the WHOLE graph, not just direct neighbors. Seeds = `entity` (comma-separated).\n" +
    "• cypher - export the (permission-filtered) graph as Neo4j Cypher for interop.\n" +
    "Works for CODE graphs too (functions/classes/calls/imports) and prose. " +
    "USE WHEN the user asks 'how are X and Y connected', 'what's related to X', 'what calls/references X', " +
    "'what are the main things here', or 'what clusters exist'. Permission-filtered. DON'T USE to fetch document text (get_context).",
  inputSchema: {
    type: "object" as const,
    properties: {
      mode: { type: "string", enum: ["neighbors", "path", "impact", "central", "communities", "cypher", "walk"], description: "which graph query" },
      entity: { type: "string", description: "the entity (for neighbors/impact), or first entity (for path)" },
      to: { type: "string", description: "the second entity (path mode only)" },
      relation: { type: "string", description: "optional relation filter (neighbors mode)" },
    },
    required: ["mode"],
  },
}

async function handler(args: Record<string, unknown>, backend: ContextBackend): Promise<ToolResult> {
  const a = args as { mode: string; entity?: string; to?: string; relation?: string }
  const gq = backend.graphQuery!
  if (a.mode === "central") {
    const hubs = (await gq.central(15)) as Array<{ label: string; degree: number; strength: number }>
    const text = hubs.length
      ? "Central concepts (most-connected):\n" + hubs.map((h) => `  ${h.label} - ${h.degree} link(s), strength ${h.strength}`).join("\n")
      : "The knowledge graph has no relationships yet."
    return { content: [{ type: "text", text }] }
  }
  if (a.mode === "communities") {
    const cs = (await gq.communities()) as Array<{ size: number; hub: string; members: string[] }>
    const text = cs.length
      ? "Communities (clusters of related entities):\n" +
        cs.slice(0, 20).map((c, i) => `  [${i + 1}] ${c.hub} +${c.size - 1} more - ${c.members.slice(0, 8).join(", ")}${c.members.length > 8 ? "…" : ""}`).join("\n")
      : "No clusters yet (graph has no relationships)."
    return { content: [{ type: "text", text }] }
  }
  if (a.mode === "walk") {
    if (!a.entity) return { content: [{ type: "text", text: "Provide `entity` (one or more comma-separated seeds)." }], isError: true }
    const seeds = a.entity.split(/\s*,\s*|\s+and\s+/i).filter(Boolean)
    const r = (await gq.walk(seeds)) as Array<{ label: string; score: number; type: string }>
    const text = r.length
      ? `Most related to ${seeds.join(", ")} (multi-hop PageRank):\n` + r.map((x) => `  ${x.label}${x.type ? ` (${x.type})` : ""} - ${x.score.toFixed(4)}`).join("\n")
      : `No entity matching "${a.entity}" in accessible knowledge.`
    return { content: [{ type: "text", text }] }
  }
  if (a.mode === "cypher") {
    const cy = await gq.cypher()
    return { content: [{ type: "text", text: cy || "// empty graph" }] }
  }
  if (!a.entity) return { content: [{ type: "text", text: "Provide `entity`." }], isError: true }
  if (a.mode === "neighbors") {
    const r = (await gq.neighbors(a.entity, a.relation)) as { entity: string; neighbors: Array<{ label: string; relation: string; direction: string; weight: number }> } | null
    if (!r) return { content: [{ type: "text", text: `No entity matching "${a.entity}" in accessible knowledge.` }] }
    const text = r.neighbors.length
      ? `${r.entity} is connected to:\n` + r.neighbors.map((n) => `  ${n.direction === "out" ? "→" : "←"} ${n.label} (${n.relation}, ×${n.weight})`).join("\n")
      : `${r.entity} has no recorded relationships.`
    return { content: [{ type: "text", text }] }
  }
  if (a.mode === "impact") {
    const r = (await gq.impact(a.entity)) as { entity: string; records: string[]; connectedEntities: Array<{ label: string; relation: string }> } | null
    if (!r) return { content: [{ type: "text", text: `No entity matching "${a.entity}" in accessible knowledge.` }] }
    const recs = r.records.length ? `Referenced by: ${r.records.join(", ")}.` : "Not referenced by any record."
    const conn = r.connectedEntities.length ? "\nConnects to: " + r.connectedEntities.map((c) => `${c.label} (${c.relation})`).join(", ") : ""
    return { content: [{ type: "text", text: `${r.entity}\n${recs}${conn}` }] }
  }
  if (a.mode === "path") {
    if (!a.to) return { content: [{ type: "text", text: "Path mode needs `entity` and `to`." }], isError: true }
    const r = (await gq.path(a.entity, a.to)) as { found: boolean; hops: number; steps: Array<{ from: string; relation: string; to: string }> }
    if (!r.found) return { content: [{ type: "text", text: `No path found between "${a.entity}" and "${a.to}" (or one isn't in accessible knowledge).` }] }
    const chain = r.steps.map((s) => `${s.from} -${s.relation}→ ${s.to}`).join("\n  then ")
    return { content: [{ type: "text", text: `Connected in ${r.hops} hop(s):\n  ${chain}` }] }
  }
  return { content: [{ type: "text", text: `unknown mode: ${a.mode}` }], isError: true }
}

export const contextRelateTool: ToolModule = { schema, handler, available: (b) => !!b.graphQuery }
