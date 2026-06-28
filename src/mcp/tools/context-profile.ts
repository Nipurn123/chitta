import type { ContextBackend } from "../backend"
import { sanitizeText } from "../../security/sanitize"
import type { ToolModule, ToolResult } from "./types"

const schema = {
  name: "context_profile",
  description:
    "Get a synthesized profile of a person, org, or any entity - the permanent facts, the most recent facts, " +
    "and what it's most connected to, rolled up from memory. USE WHEN: 'who is X', 'what do you know about X', " +
    "'summarize what we know about X', or before personalizing a response to someone. Returns the CURRENT truth " +
    "(contradictions already resolved, forgotten facts excluded), permission-filtered to what you may see. " +
    "DON'T USE for a one-off fact (use get_context) or general world knowledge.",
  inputSchema: {
    type: "object" as const,
    properties: {
      subject: { type: "string", description: "the person/org/entity to profile (name as written)" },
    },
    required: ["subject"],
  },
}

async function handler(args: Record<string, unknown>, backend: ContextBackend): Promise<ToolResult> {
  const subject = String((args as any).subject ?? "").trim()
  if (!subject) return { content: [{ type: "text", text: "Provide a subject to profile." }], isError: true }
  const p = await backend.profile!(subject)
  if (!p) return { content: [{ type: "text", text: `No memory about "${subject}" (or you don't have access).` }] }
  const out: string[] = [`Profile - ${sanitizeText(p.subject)}`]
  if (p.staticFacts.length) out.push("", "Permanent:", ...p.staticFacts.map((f) => `• ${sanitizeText(f)}`))
  if (p.recentFacts.length) out.push("", "Current (most recent first):", ...p.recentFacts.map((f) => `• ${sanitizeText(f)}`))
  if (p.related.length) out.push("", `Connected to: ${p.related.map((r) => sanitizeText(r)).join(", ")}`)
  return { content: [{ type: "text", text: out.join("\n") }] }
}

export const contextProfileTool: ToolModule = { schema, handler, available: (b) => !!b.profile }
