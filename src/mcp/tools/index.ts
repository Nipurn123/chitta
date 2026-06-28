// Aggregates the per-tool modules into the ListTools schema array and a
// name→handler dispatch map, applying each tool's capability gate against the
// active backend. Order matches the original inline TOOLS array exactly so the
// ListTools response and the context_about "## Tools" section are unchanged.

import type { ContextBackend } from "../backend"
import { getContextTool } from "./get-context"
import { contextIngestTool } from "./context-ingest"
import { contextForgetTool } from "./context-forget"
import { contextProfileTool } from "./context-profile"
import { contextGraphTool } from "./context-graph"
import { contextRebuildTool } from "./context-rebuild"
import { contextRelateTool } from "./context-relate"
import { contextAboutTool, setAboutToolList } from "./context-about"
import type { ToolModule, ToolResult, ToolSchema } from "./types"

const ALL: ToolModule[] = [
  getContextTool,
  contextIngestTool,
  contextForgetTool,
  contextProfileTool,
  contextGraphTool,
  contextRebuildTool,
  contextRelateTool,
  contextAboutTool,
]

export interface ResolvedTools {
  /** Capability-gated schemas, for ListTools (and the about report). */
  schemas: ToolSchema[]
  /** name → handler for CallTool dispatch (only available tools are present). */
  dispatch: Map<string, ToolModule["handler"]>
}

export function resolveTools(backend: ContextBackend): ResolvedTools {
  const active = ALL.filter((t) => (t.available ? t.available(backend) : true))
  const schemas = active.map((t) => t.schema)
  const dispatch = new Map(active.map((t) => [t.schema.name, t.handler]))
  // Keep context_about's "## Tools" listing in sync with what's actually exposed.
  setAboutToolList(schemas)
  return { schemas, dispatch }
}

export type { ToolModule, ToolResult, ToolSchema }
