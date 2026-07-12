// Redaction for the audit log: produce a NON-SENSITIVE summary of a tool call - enough
// to answer "who searched/stored what, when" for compliance, without ever writing the raw
// stored CONTENT into the trail. For ingest we record the title + payload SIZE only; for
// reads we record the query/subject (the intent). Kept separate from server.ts so it's unit
// testable (importing server.ts would boot the MCP transport).

export function auditTarget(name: string, args: Record<string, unknown>): string {
  const a = args as Record<string, string>
  if (name === "context_ingest") return `name="${a.name ?? ""}" (${(a.content ?? "").length} bytes)`
  if (name === "context_about" || name === "context_graph" || name === "context_rebuild" || name === "context_health") return ""
  return String(a.query ?? a.subject ?? a.name ?? "").slice(0, 200)
}
