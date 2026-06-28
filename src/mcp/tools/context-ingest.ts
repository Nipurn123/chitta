import type { ContextBackend } from "../backend"
import { slug, type ToolModule, type ToolResult } from "./types"

const schema = {
  name: "context_ingest",
  description:
    "Remember new information durably. USE WHEN: the user states a fact, preference, person, project, " +
    "decision, or document worth keeping, or says 'remember/store/note that…'. Don't ask permission for " +
    "obvious saves - just store it. Writes a record + permission edges (ACL) + vector chunks + a concept " +
    "graph. IMPORTANT: YOU already understood this content, so ALSO pass the `entities` and `relations` you " +
    "extracted - they're stored as precise TYPED triples (no second model re-reads it). Relations should be " +
    "subject→predicate→object with a SHORT snake_case predicate (e.g. partners_with, acquired, works_at, " +
    "deploys, located_in). DON'T USE for transient chit-chat or one-off computations.",
  inputSchema: {
    type: "object" as const,
    properties: {
      content: { type: "string", description: "text to store" },
      name: { type: "string", description: "short title" },
      entities: {
        type: "array",
        description: "entities you identified in the content (people, orgs, products, concepts)",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "entity name as written" },
            type: { type: "string", description: "PERSON | ORG | PRODUCT | CONCEPT | PLACE | …" },
          },
          required: ["name"],
        },
      },
      relations: {
        type: "array",
        description: "typed relationships between entities (subject → predicate → object)",
        items: {
          type: "object",
          properties: {
            from: { type: "string", description: "subject entity name" },
            to: { type: "string", description: "object entity name" },
            type: { type: "string", description: "SHORT snake_case predicate, e.g. partners_with / acquired / works_at" },
            confidence: { type: "number", description: "0..1 how certain (optional)" },
          },
          required: ["from", "to", "type"],
        },
      },
      share: {
        type: "array",
        description: "principal ids (users or groups) to ALSO grant read access - default is private to you",
        items: { type: "string" },
      },
      org_wide: { type: "boolean", description: "share with everyone in your org (default false)" },
    },
    required: ["content", "name"],
  },
}

async function handler(args: Record<string, unknown>, backend: ContextBackend): Promise<ToolResult> {
  const a = args as {
    content: string
    name: string
    entities?: Array<{ name: string; type?: string }>
    relations?: Array<{ from: string; to: string; type: string; confidence?: number }>
    share?: string[]
    org_wide?: boolean
  }
  // owner is always added by authorizedIngest; `share` widens to named principals/
  // groups; `org_wide` shares with everyone in the org. The authorizer rejects any
  // grant outside the caller's scope (no over-sharing).
  const principals = [...new Set([backend.userId, ...(a.share ?? [])])]
  const out = await backend.ingest!({
    recordId: `${slug(a.name)}-${Date.now().toString(36)}`,
    orgId: backend.orgId,
    recordName: a.name,
    text: a.content,
    permittedPrincipals: principals,
    shareWithOrg: a.org_wide ? backend.orgId : undefined,
    entities: a.entities,
    relations: a.relations,
  })
  const typed = a.relations?.length ? `, ${a.relations.length} typed relation(s)` : ""
  const vis = a.org_wide ? "org-wide" : a.share?.length ? `shared with ${a.share.join(", ")}` : "private"
  return {
    content: [
      { type: "text", text: `Stored "${a.name}" (${out.chunks} chunk(s), ${out.entities} concept(s)${typed}; ${vis}) as ${out.recordId}.` },
    ],
  }
}

export const contextIngestTool: ToolModule = { schema, handler, available: (b) => !!b.ingest }
