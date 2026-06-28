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
// The 6 tools live one-per-module under ./tools; this file just wires the server:
// resolve the backend, build the (capability-gated) tool list, register ListTools
// from those schemas, dispatch CallTool through the name→handler map, and connect
// the stdio transport.

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { resolveBackend } from "./backend"
import { resolveTools } from "./tools"

const backend = resolveBackend()
const { schemas, dispatch } = resolveTools(backend)

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
  "what you retrieve.",
].join("\n")

const server = new Server(
  { name: "100x-context", version: "0.1.0" },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: schemas }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params
  try {
    const handler = dispatch.get(name)
    if (!handler) return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true }
    return await handler(args as Record<string, unknown>, backend)
  } catch (e) {
    const msg = e instanceof Error && e.name === "AuthorizationError" ? `Not authorized: ${e.message}` : `error: ${String(e)}`
    return { content: [{ type: "text", text: msg }], isError: true }
  }
})

await server.connect(new StdioServerTransport())
console.error(`[100x-context] MCP server ready (mode=${backend.mode}, user=${backend.userId})`)
