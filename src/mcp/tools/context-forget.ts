import type { ContextBackend } from "../backend"
import type { ToolModule, ToolResult } from "./types"

const schema = {
  name: "context_forget",
  description:
    "Forget stored memories that are no longer true or wanted. USE WHEN: the user says 'forget that…', " +
    "'that's no longer true', 'delete what you know about…', or a fact is explicitly retracted. Describe " +
    "WHAT to forget in natural language (e.g. 'my old address', 'that I work at Google'); matching memories " +
    "within what YOU can access are soft-deleted (history is kept, they stop appearing in recall). You can " +
    "only ever forget what you're permitted to see. DON'T USE to correct a fact - for that just context_ingest " +
    "the new value (a single-valued fact auto-supersedes the old one).",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "natural-language description of the memory/memories to forget" },
      reason: { type: "string", description: "why it's being forgotten (optional, stored for audit)" },
    },
    required: ["query"],
  },
}

async function handler(args: Record<string, unknown>, backend: ContextBackend): Promise<ToolResult> {
  const query = String((args as any).query ?? "")
  const reason = (args as any).reason ? String((args as any).reason) : undefined
  if (!query.trim()) return { content: [{ type: "text", text: "Nothing to forget: provide a description." }], isError: true }
  const forgotten = await backend.forget!(query, reason)
  if (forgotten.length === 0) {
    return { content: [{ type: "text", text: `No matching memories found to forget for "${query}".` }] }
  }
  const list = forgotten.map((m) => `• ${m}`).join("\n")
  return { content: [{ type: "text", text: `Forgot ${forgotten.length} memor${forgotten.length === 1 ? "y" : "ies"}:\n${list}` }] }
}

export const contextForgetTool: ToolModule = { schema, handler, available: (b) => !!b.forget }
