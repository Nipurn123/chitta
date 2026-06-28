// Shared shapes for the modular MCP tools. Each tool module exports its name,
// its JSON input schema (the entry that used to live in server.ts's TOOLS array),
// and an async handler `(args, backend) => result`. A tool may be GATED behind a
// backend capability via `available(backend)` - when it returns false the tool is
// not listed and not dispatchable (identical to the old `...(backend.x ? [...] : [])`).

import type { ContextBackend } from "../backend"

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
  // The MCP SDK's ServerResult union accepts an open record; this index signature
  // lets ToolResult satisfy that branch (so handlers don't need the task-result fields).
  [key: string]: unknown
}

export interface ToolSchema {
  name: string
  description: string
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] }
}

export interface ToolModule {
  schema: ToolSchema
  handler: (args: Record<string, unknown>, backend: ContextBackend) => Promise<ToolResult>
  /** Optional capability gate; defaults to always-available when omitted. */
  available?: (backend: ContextBackend) => boolean
}

/** Slugify a title into a record-id prefix. */
export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "note"
}
