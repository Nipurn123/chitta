// Skill installer - copies the bundled SKILL.md into a tool's skills directory as
// <skillsDir>/chitta/SKILL.md. Tools that support Claude-style skills get guidance on
// WHEN to use Chitta's MCP tools (recall before answering, ingest durable facts, etc.).
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
// assets/skill/SKILL.md lives at repo root (../../assets from src/install). When compiled,
// the build embeds it next to the binary; fall back to an inline copy if not found.
const SKILL_SRC_CANDIDATES = [
  join(HERE, "..", "..", "assets", "skill", "SKILL.md"),
  join(HERE, "assets", "skill", "SKILL.md"),
]

const INLINE_FALLBACK = `---
name: chitta
description: Permission-aware long-term memory for AI agents. Use to recall prior context before answering, store durable facts/decisions, and query how concepts relate. Backed by Chitta's MCP tools (context_ingest, get_context, context_graph).
---

# Chitta - memory for this agent

Chitta gives you persistent, permission-aware memory via MCP tools. Use it proactively.

- **Before answering** anything that may depend on prior work, call **get_context** with the
  user's question to retrieve ranked, cited, permission-filtered snippets.
- **After learning** a durable fact, decision, or preference, call **context_ingest** to store it.
- To understand **how things relate**, call **context_graph**.

If MCP tools are unavailable, use the CLI: \`bunx @100xprompt/chitta query "<q>"\` and
\`bunx @100xprompt/chitta ingest --text "<fact>"\`.
`

export function skillContent(): string {
  for (const p of SKILL_SRC_CANDIDATES) if (existsSync(p)) return readFileSync(p, "utf8")
  return INLINE_FALLBACK
}

/** Write chitta/SKILL.md under the given skills directory. Returns the file path. */
export function installSkill(skillsDir: string): string {
  const dir = join(skillsDir, "chitta")
  mkdirSync(dir, { recursive: true })
  const dst = join(dir, "SKILL.md")
  writeFileSync(dst, skillContent())
  return dst
}
