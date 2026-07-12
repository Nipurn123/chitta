#!/usr/bin/env bun
// 100x Context - MCP server. Exposes the knowledge graph as standard MCP tools so
// ANY client (100xprompt, Claude Desktop, Cursor, IDEs) uses it via config alone,
// no code changes. Ships as one command; point it at the central office backend
// with env (see backend.ts) to share one org-wide graph with per-user ACL.
//
//   Client config:
//   "mcp": { "context": { "type": "local", "command": ["chitta"],
//            "environment": { "CONTEXT_USER_ID": "alice", "CONTEXT_ORG_ID": "acme" } } }
//
// The tools live one-per-module under ./tools; this file just wires the server:
// resolve the backend, build the (capability-gated) tool list, register ListTools
// from those schemas, dispatch CallTool through the name→handler map, register the
// read-only MCP resources (memory://graph, memory://profile/{entity}, memory://stats
// - see ./resources), and connect the stdio transport.

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { resolveBackend } from "./backend"
import { resolveTools } from "./tools"
import { resolveResources } from "./resources"
import { auditTarget } from "./audit-redact"

const backend = resolveBackend()
const { schemas, dispatch } = resolveTools(backend)
const resources = resolveResources(backend)

const INSTRUCTIONS = [
  "100x Context - a permission-aware knowledge graph + vector memory. It is the user's / organization's",
  "long-term memory. Treat it as the source of truth for anything personal or organization-specific.",
  "",
  "WHEN TO USE EACH TOOL:",
  "• context_ingest - Call WHENEVER the user states something durable worth remembering: facts, preferences,",
  "  people, projects, decisions, documents, or any 'remember that…/store…/note that…/I am/like/work on…'.",
  "  Don't ask permission for obvious saves - just store it. Not for transient chit-chat.",
  "  YOU ARE THE EXTRACTOR: you just read and understood this content, so ALWAYS pass the `entities` and",
  "  `relations` you identified alongside the text. Relations are subject→predicate→object with a SHORT",
  "  snake_case predicate (partners_with, acquired, works_at, deploys, located_in, ceo_of…). This stores precise",
  "  TYPED triples - no second model re-reads the text, and the graph can answer relational questions exactly.",
  "• get_context - Call BEFORE answering ANY question that could touch the user's own notes, people, projects,",
  "  org knowledge, or prior statements ('who/what/when did I…', 'what do we know about…', 'remind me…').",
  "  Always check memory first instead of guessing. If it returns nothing, say so plainly.",
  "• context_graph - Call when the user asks how things relate, for an overview, or 'what do you know about X' /",
  "  'how are these connected' - it returns the concept map (entities + relationships).",
  "• context_health - Call for a quick 'what does my memory look like' checkup: store size, memory counts by",
  "  kind, engine status (ANN/encryption/audit), and the most-connected concepts.",
  "• context_about - Call to discover this server's capabilities, current mode, storage, engines, and live stats",
  "  (e.g. when unsure what memory can do, or to report status).",
  "",
  "HOW IT WORKS (set expectations from this):",
  "• Two stores behind one interface: a GRAPH (records, people, concepts + relationships + permissions) and a",
  "  VECTOR store (semantic search). get_context combines them: ACL-filter (what the user may see) → semantic",
  "  search over only those records → expand along the concept graph → return ranked, cited snippets.",
  "• EVERYTHING IS PERMISSION-FILTERED. Results only ever contain what the asking user is authorized to see.",
  "  Never assume the user can access more than what comes back; never invent beyond the returned content.",
  "• WRITES ARE AUTHORIZED TOO: roles (admin/editor/viewer) gate creation; only an owner or admin may delete/",
  "  modify a record; non-admins can't share outside their org/groups. If a write is denied, relay that plainly.",
  "",
  "TIER SYSTEM (set by config, not by you - tool behavior is identical either way):",
  "• local (default): a single private SQLite store on this machine - personal memory, no servers.",
  "• central-office: a shared organization-wide store (ArangoDB graph + Qdrant vectors). Everyone shares one",
  "  knowledge base, but each user sees only what their ACL permits. Identity comes from CONTEXT_USER_ID/ORG_ID.",
  "",
  "DEFAULT BEHAVIOR: prefer recall over guessing (get_context first); ingest durable facts proactively; cite",
  "what you retrieve. When a context_ingest response carries a 'note:' that it superseded or contradicted a",
  "previous belief, RELAY that to the user - they should know their stored memory just changed.",
].join("\n")

const server = new Server(
  { name: "100x-context", version: "0.1.0" },
  { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: schemas }))

// Read-only resources: the same ACL-scoped payloads as the tools, as URI-addressable
// JSON (memory://graph, memory://profile/{entity}, memory://stats). Reads are audited
// like tool calls so "who read what" stays complete when auditing is on.
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: resources.list }))
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: resources.templates }))
server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const uri = req.params.uri
  try {
    const contents = await resources.read(uri)
    backend.audit?.({ action: "resources/read", target: uri, ok: true })
    return { contents: [contents] }
  } catch (e) {
    backend.audit?.({ action: "resources/read", target: uri, ok: false, detail: "error" })
    throw e
  }
})

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params
  const a = args as Record<string, unknown>
  try {
    const handler = dispatch.get(name)
    if (!handler) return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true }
    const res = await handler(a, backend)
    backend.audit?.({ action: name, target: auditTarget(name, a), ok: !res.isError, detail: res.isError ? "error" : "" })
    return res
  } catch (e) {
    const denied = e instanceof Error && e.name === "AuthorizationError"
    backend.audit?.({ action: name, target: auditTarget(name, a), ok: false, detail: denied ? "denied" : "error" })
    const msg = denied ? `Not authorized: ${(e as Error).message}` : `error: ${String(e)}`
    return { content: [{ type: "text", text: msg }], isError: true }
  }
})

await server.connect(new StdioServerTransport())
console.error(`[100x-context] MCP server ready (mode=${backend.mode}, user=${backend.userId})`)
