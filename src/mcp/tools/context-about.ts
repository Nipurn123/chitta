import { CodeExtractor } from "../../embedded/code-extractor"
import type { ContextBackend } from "../backend"
import type { ToolModule, ToolResult, ToolSchema } from "./types"

// The about/describe output lists every AVAILABLE tool with its description. The
// index injects the resolved tool list (after capability gating) so this stays in
// lockstep with what ListTools reports - identical to the old inline TOOLS loop.
let listedTools: ToolSchema[] = []
export function setAboutToolList(tools: ToolSchema[]): void {
  listedTools = tools
}

const schema = {
  name: "context_about",
  description:
    "Describe this context server: its purpose, current mode/identity/storage, the vector + knowledge-graph " +
    "engines in use, live counts, and every tool with what it's for. Call this first to discover capabilities.",
  inputSchema: { type: "object" as const, properties: {} },
}

// Self-describing capability report for discovery (the context_about tool).
async function describe(backend: ContextBackend): Promise<string> {
  const lines: string[] = [
    "# 100x Context - permission-aware knowledge graph + vector memory (MCP server)",
    "",
    "Stores PROSE or CODE as: a record node + permission edges (ACL) + vector chunks + an extracted graph.",
    "Code files are parsed with tree-sitter into a real code graph (functions/classes + calls/imports/defines),",
    "so the same graph queries (neighbors / path / impact / communities) work over code as well as notes.",
    "Retrieval = ACL filter (who can see what) → semantic vector search (restricted to accessible records) →",
    "GraphRAG expansion along concept links → ranked, cited snippets.",
    "",
    "The graph is BI-TEMPORAL and self-densifying: every relationship carries a weight that accumulates as it's",
    "re-asserted (frequency≈confidence), provenance (which records asserted it), and validity intervals. New facts",
    "MERGE into existing ones rather than duplicating; a newer single-valued fact (e.g. moved cities) SUPERSEDES the",
    "old one non-destructively - the prior fact stays in history (marked expired) and never surfaces as current.",
    "",
    "## Current state",
    `- mode: ${backend.mode}  ·  user: ${backend.userId}  ·  org: ${backend.orgId}`,
    `- storage: ${backend.storage}`,
    `- vector search: ${backend.vectorIndex}`,
    `- embeddings: ${backend.embeddings}`,
    `- knowledge extraction: ${backend.extraction}`,
    `- code graph: tree-sitter AST over ${CodeExtractor.languages().length} languages (functions/classes + calls/imports/defines)`,
  ]
  if (backend.stats) {
    const s = await backend.stats()
    lines.push(`- contents: ${s.records} record(s), ${s.chunks} chunk(s), ${s.entities} concept(s), ${s.relations} relationship(s)`)
  }
  lines.push("", "## Tools")
  for (const t of listedTools) lines.push(`- **${t.name}** - ${t.description}`)
  lines.push(
    "",
    "## Modes",
    "- personal (default): one private SQLite file, single owner - no ACL friction.",
    "- TEAM / multi-user (embedded): point multiple clients at the SAME SQLite file (CONTEXT_DB) but give each",
    "  its own CONTEXT_USER_ID / CONTEXT_ORG_ID / CONTEXT_USER_ROLE / CONTEXT_USER_GROUPS. ONE shared graph",
    "  (entities are a common backbone), but every user sees ONLY their ACL slice - private to the owner, shared",
    "  with named groups (context_ingest `share`), or org-wide (`org_wide`). Edges are permission-filtered per",
    "  provenance, so a private relationship between two otherwise-visible entities never leaks.",
    "- central-office: set CONTEXT_ARANGO_URL/QDRANT_URL/EMBED_URL/COLLECTION → server-backed org graph, same ACL.",
  )
  return lines.join("\n")
}

async function handler(_args: Record<string, unknown>, backend: ContextBackend): Promise<ToolResult> {
  return { content: [{ type: "text", text: await describe(backend) }] }
}

export const contextAboutTool: ToolModule = { schema, handler }
