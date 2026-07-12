import type { ContextBackend } from "../backend"
import type { ToolModule, ToolResult } from "./types"
import { sanitizeText } from "../../security/sanitize"

const schema = {
  name: "context_reflect",
  description:
    "Step back and SYNTHESIZE higher-order insight from everything you know about the user/org - not a " +
    "lookup, but reflection: the recurring focus (what the knowledge is most built around), what has " +
    "CHANGED over time, known preferences/how-tos, and recent activity. USE WHEN the user asks 'what have " +
    "you learned about me', 'what patterns do you see', 'summarize what you know', or to self-orient before " +
    "a complex, personalized task. Permission-filtered (built only from what you may see).",
  inputSchema: { type: "object" as const, properties: {} },
}

const HEADING: Record<string, string> = {
  focus: "Recurring focus",
  change: "What changed",
  preference: "Known preferences",
  recent: "Recent activity",
}

async function handler(_args: Record<string, unknown>, backend: ContextBackend): Promise<ToolResult> {
  const insights = backend.reflect ? await backend.reflect() : []
  if (insights.length === 0) return { content: [{ type: "text", text: "Not enough stored context to reflect on yet." }] }
  // Group by category, preserving the reflect() order within each group.
  const groups = new Map<string, string[]>()
  for (const i of insights) {
    const g = groups.get(i.category) ?? []
    g.push(sanitizeText(i.text))
    groups.set(i.category, g)
  }
  const blocks = [...groups.entries()].map(([cat, lines]) => `${HEADING[cat] ?? cat}:\n${lines.map((l) => `  • ${l}`).join("\n")}`)
  return { content: [{ type: "text", text: `Reflection on what I know:\n\n${blocks.join("\n\n")}` }] }
}

export const contextReflectTool: ToolModule = { schema, handler, available: (b) => !!b.reflect }
