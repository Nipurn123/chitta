import type { ContextBackend } from "../backend"
import type { ToolModule, ToolResult } from "./types"
import { sanitizeText } from "../../security/sanitize"

const schema = {
  name: "context_timeline",
  description:
    "Reason over TIME using the memory's bi-temporal history. Two modes:\n" +
    "• timeline (pass `subject`) - how something evolved: every fact change (with when it became true) " +
    "interleaved with the experiences involving it, in chronological order. 'How did X change over time?'\n" +
    "• as-of (pass `as_of` = a date) - memory time-travel: the facts as they were BELIEVED at that past " +
    "date (optionally about `subject`). 'What did we know about X back in <month/year>?'\n" +
    "Permission-filtered. DON'T USE for the current state (get_context) or the raw relationship map (context_relate).",
  inputSchema: {
    type: "object" as const,
    properties: {
      subject: { type: "string", description: "the person/org/thing whose history you want" },
      as_of: { type: "string", description: "a past date (ISO or 'YYYY-MM-DD') → facts believed AS OF then" },
    },
  },
}

async function handler(args: Record<string, unknown>, backend: ContextBackend): Promise<ToolResult> {
  const a = args as { subject?: string; as_of?: string }
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

  // as-of mode: reconstruct the memory's past state at a transaction time.
  if (a.as_of) {
    const t = Date.parse(a.as_of)
    if (Number.isNaN(t)) return { content: [{ type: "text", text: `Couldn't parse a date from "${a.as_of}".` }], isError: true }
    const facts = backend.asOf ? await backend.asOf(t, a.subject) : []
    const scope = a.subject ? ` about ${sanitizeText(a.subject)}` : ""
    const text = facts.length
      ? `As of ${day(t)}, the known facts${scope} were:\n` + facts.map((f) => `  • ${sanitizeText(f)}`).join("\n")
      : `Nothing was known${scope} as of ${day(t)}.`
    return { content: [{ type: "text", text }] }
  }

  // timeline mode: chronological evolution of a subject.
  if (a.subject && backend.timeline) {
    const tl = await backend.timeline(a.subject)
    if (tl.events.length === 0) return { content: [{ type: "text", text: `No recorded history for "${sanitizeText(a.subject)}".` }] }
    const lines = tl.events.map((e) => {
      const tag = e.kind === "episode" ? "experience" : e.superseded ? "fact (later changed)" : "fact"
      return `  ${day(e.at)}  [${tag}] ${sanitizeText(e.text)}`
    })
    return { content: [{ type: "text", text: `Timeline for ${sanitizeText(tl.subject)}:\n${lines.join("\n")}` }] }
  }

  return { content: [{ type: "text", text: "Provide `subject` (its timeline) and/or `as_of` (facts believed at that date)." }], isError: true }
}

export const contextTimelineTool: ToolModule = { schema, handler, available: (b) => !!b.timeline }
