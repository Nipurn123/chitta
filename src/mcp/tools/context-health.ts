import type { ContextBackend } from "../backend"
import type { ToolModule, ToolResult } from "./types"

const schema = {
  name: "context_health",
  description:
    "One-call memory checkup: store size, memory counts by kind (semantic/episodic/procedural), engine " +
    "status (vector index, encryption at rest, audit log), and the most-connected concepts. USE WHEN: the " +
    "user asks 'what does my memory look like', 'how much do you remember', or wants a quick status/health " +
    "overview. DON'T USE to fetch content (get_context) or the full capability docs (context_about).",
  inputSchema: { type: "object" as const, properties: {} },
}

// The "what does my memory look like" report - live counts + engine status + the graph's
// hubs, formatted like context_about's Current-state section but without the docs.
async function handler(_args: Record<string, unknown>, backend: ContextBackend): Promise<ToolResult> {
  const s = await backend.stats!()
  const lines: string[] = [
    "# Memory health",
    `- mode: ${backend.mode}  ·  user: ${backend.userId}  ·  org: ${backend.orgId}`,
    `- storage: ${backend.storage}`,
    "",
    "## Store",
    `- ${s.records} record(s), ${s.chunks} chunk(s), ${s.entities} concept(s), ${s.relations} relationship(s)`,
  ]
  if (s.memories !== undefined) {
    const k = s.memoryKinds
    const kinds = k ? ` (${k.semantic} semantic · ${k.episodic} episodic · ${k.procedural} procedural)` : ""
    lines.push(`- living memory: ${s.memories.current} current memor(ies)${kinds}, ${s.memories.forgotten} forgotten (of ${s.memories.total} total versions)`)
  }
  lines.push(
    "",
    "## Engines",
    `- vector search: ${backend.vectorIndex}`,
    `- encryption at rest: ${process.env.CONTEXT_DB_KEY ? "ON (libSQL AES-256 whole-file)" : "off (set CONTEXT_DB_KEY; rotate with `chitta rekey`)"}`,
    `- audit log: ${backend.audit ? "ON (append-only, hash-chained, tamper-evident)" : "off (set CHITTA_AUDIT=1)"}`,
  )
  if (backend.graphQuery) {
    const hubs = (await backend.graphQuery.central(3)) as Array<{ label: string; degree: number; strength: number }>
    lines.push(
      "",
      "## Most-connected concepts",
      ...(hubs.length ? hubs.map((h) => `- ${h.label} - ${h.degree} link(s), strength ${h.strength}`) : ["- none yet (no relationships stored)"]),
    )
  }
  return { content: [{ type: "text", text: lines.join("\n") }] }
}

export const contextHealthTool: ToolModule = { schema, handler, available: (b) => !!b.stats }
