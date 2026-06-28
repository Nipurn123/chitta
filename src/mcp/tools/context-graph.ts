import type { ContextBackend } from "../backend"
import type { ToolModule, ToolResult } from "./types"

const schema = {
  name: "context_graph",
  description:
    "See how stored concepts connect. USE WHEN: the user asks for an overview, 'what do you know about X', " +
    "'how are these related', or wants the map of their knowledge. Returns entities + relationships " +
    "(permission-filtered). DON'T USE to fetch document text - that's get_context.",
  inputSchema: { type: "object" as const, properties: {} },
}

async function handler(_args: Record<string, unknown>, backend: ContextBackend): Promise<ToolResult> {
  const g = await backend.graph!()
  const byId = new Map(g.entities.map((e) => [e.id, e.label]))
  const lines = [
    `Knowledge graph: ${g.entities.length} concept(s), ${g.relations.length} relationship(s).`,
    ...g.relations.slice(0, 50).map((r) => `  ${byId.get(r.from) ?? r.from} ── ${byId.get(r.to) ?? r.to}`),
  ]
  return { content: [{ type: "text", text: lines.join("\n") }] }
}

export const contextGraphTool: ToolModule = { schema, handler, available: (b) => !!b.graph }
