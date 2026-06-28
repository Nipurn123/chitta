import type { ContextBackend } from "../backend"
import type { ToolModule, ToolResult } from "./types"

const schema = {
  name: "context_rebuild",
  description:
    "Re-extract the knowledge graph over ALL stored records using the current extractor. Run this after " +
    "connecting a local LLM (CONTEXT_LLM_URL) to upgrade older data from untyped to TYPED triples " +
    "(e.g. 'Google partners_with HSBC'), so questions resolve to exact facts. May take a while on large stores.",
  inputSchema: { type: "object" as const, properties: {} },
}

async function handler(_args: Record<string, unknown>, backend: ContextBackend): Promise<ToolResult> {
  const r = await backend.rebuild!()
  return {
    content: [
      { type: "text", text: `Rebuilt the knowledge graph: ${r.records} record(s) → ${r.entities} concept-mention(s) re-extracted with the current model.` },
    ],
  }
}

export const contextRebuildTool: ToolModule = { schema, handler, available: (b) => !!b.rebuild }
