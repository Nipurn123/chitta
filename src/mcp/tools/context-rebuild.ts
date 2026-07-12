import type { ContextBackend } from "../backend"
import type { ToolModule, ToolResult } from "./types"

const schema = {
  name: "context_rebuild",
  description:
    "Re-extract the knowledge graph over ALL stored records using the current extractor, then rebuild the " +
    "atomic-memory layer from the resulting typed graph. Run this after connecting a local LLM " +
    "(CONTEXT_LLM_URL) to upgrade older data to TYPED triples, OR to backfill memories for data ingested " +
    "before the memory layer existed (so context_profile and the get_context memory section populate). " +
    "May take a while on large stores.",
  inputSchema: { type: "object" as const, properties: {} },
}

async function handler(_args: Record<string, unknown>, backend: ContextBackend): Promise<ToolResult> {
  const r = await backend.rebuild!()
  return {
    content: [
      {
        type: "text",
        text:
          `Rebuilt the knowledge graph: ${r.records} record(s) → ${r.entities} concept-mention(s) re-extracted with the current model. ` +
          `Backfilled ${r.memories} atomic memor${r.memories === 1 ? "y" : "ies"} from the typed graph.`,
      },
    ],
  }
}

export const contextRebuildTool: ToolModule = { schema, handler, available: (b) => !!b.rebuild }
