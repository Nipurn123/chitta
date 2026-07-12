// The platform registry: one row per AI tool, with its EXACT (verified 2025-2026) MCP
// config location + format and Skill directory. Paths are resolved per-OS at call time.
// Adding a tool = adding a row here; the writers in writers.ts handle each `format`.
import { homedir } from "node:os"
import { join } from "node:path"

const HOME = homedir()
const PLAT = process.platform // "darwin" | "linux" | "win32"

// App-data root per OS (where Electron/VS Code apps store user config).
const appData = (): string =>
  PLAT === "darwin" ? join(HOME, "Library", "Application Support")
  : PLAT === "win32" ? (process.env.APPDATA ?? join(HOME, "AppData", "Roaming"))
  : join(HOME, ".config")

// VS Code "User" dir (settings.json / mcp.json / globalStorage live here).
const vscodeUser = (): string => join(appData(), "Code", "User")

/** How the MCP server entry is shaped + where it nests. */
export type Format =
  | "json"   // JSON object: container[key][name] = entry
  | "json-array" // JSON: container[key] is an ARRAY of entries (Trae)
  | "yaml"   // YAML: merge chitta into container[key] (Goose)
  | "yaml-file" // a dedicated standalone YAML block file we fully own (Continue.dev)
  | "toml"   // Codex TOML
  | "manual" // no stable on-disk path → print instructions

/** The per-tool server-entry dialect. */
export type Entry = "standard" | "vscode" | "zed" | "local" | "trae" | "goose" | "continue"

export interface Platform {
  id: string
  label: string
  format: Format
  /** top-level container key in the config (e.g. mcpServers / servers / context_servers / mcp / amp.mcpServers) */
  key?: string
  entry?: Entry
  /** absolute global/user config path (null if tool has no global file) */
  global: string | null
  /** existence probe for auto-detect, when the config path's own dir isn't a reliable signal
   *  (e.g. we write into a subfolder the tool creates lazily). Falls back to `global`. */
  detect?: string
  /** project-relative config path (undefined if not supported) */
  project?: string
  /** skill dirs (we append `/chitta/SKILL.md`); undefined if tool has no skills */
  skillGlobal?: string
  skillProject?: string
  /** optional note shown to the user */
  note?: string
}

export const PLATFORMS: Platform[] = [
  {
    id: "claude-code", label: "Claude Code", format: "json", key: "mcpServers", entry: "standard",
    global: join(HOME, ".claude.json"), project: ".mcp.json",
    skillGlobal: join(HOME, ".claude", "skills"), skillProject: ".claude/skills",
    note: "global edits ~/.claude.json; `claude mcp add` is the official alternative.",
  },
  {
    id: "claude-desktop", label: "Claude Desktop", format: "json", key: "mcpServers", entry: "standard",
    global: join(appData(), "Claude", "claude_desktop_config.json"),
    note: "restart Claude Desktop after install (config is read once at startup).",
  },
  {
    id: "cursor", label: "Cursor", format: "json", key: "mcpServers", entry: "standard",
    global: join(HOME, ".cursor", "mcp.json"), project: ".cursor/mcp.json",
    skillGlobal: join(HOME, ".cursor", "skills"), skillProject: ".cursor/skills",
  },
  {
    id: "vscode", label: "VS Code (Copilot)", format: "json", key: "servers", entry: "vscode",
    global: join(vscodeUser(), "mcp.json"), project: ".vscode/mcp.json",
  },
  {
    id: "windsurf", label: "Windsurf", format: "json", key: "mcpServers", entry: "standard",
    global: join(HOME, ".codeium", "windsurf", "mcp_config.json"),
  },
  {
    id: "zed", label: "Zed", format: "json", key: "context_servers", entry: "zed",
    global: join(HOME, ".config", "zed", "settings.json"), project: ".zed/settings.json",
  },
  {
    id: "cline", label: "Cline", format: "json", key: "mcpServers", entry: "standard",
    global: join(vscodeUser(), "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
  },
  {
    id: "roo", label: "Roo Code", format: "json", key: "mcpServers", entry: "standard",
    global: join(vscodeUser(), "globalStorage", "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json"),
    project: ".roo/mcp.json",
  },
  {
    id: "codex", label: "Codex CLI", format: "toml",
    global: join(HOME, ".codex", "config.toml"), project: ".codex/config.toml",
  },
  {
    id: "gemini", label: "Gemini CLI", format: "json", key: "mcpServers", entry: "standard",
    global: join(HOME, ".gemini", "settings.json"), project: ".gemini/settings.json",
    skillGlobal: join(HOME, ".gemini", "skills"), skillProject: ".gemini/skills",
  },
  {
    id: "opencode", label: "opencode", format: "json", key: "mcp", entry: "local",
    global: join(HOME, ".config", "opencode", "opencode.json"), project: "opencode.json",
    skillGlobal: join(HOME, ".config", "opencode", "skills"), skillProject: ".opencode/skills",
  },
  {
    id: "kiro", label: "Kiro", format: "json", key: "mcpServers", entry: "standard",
    global: join(HOME, ".kiro", "settings", "mcp.json"), project: ".kiro/settings/mcp.json",
    skillGlobal: join(HOME, ".kiro", "skills"), skillProject: ".kiro/skills",
  },
  {
    id: "amp", label: "Amp", format: "json", key: "amp.mcpServers", entry: "standard",
    global: join(appData(), "amp", "settings.json"), project: ".amp/settings.json",
    skillGlobal: join(HOME, ".config", "agents", "skills"), skillProject: ".agents/skills",
  },
  {
    id: "factory", label: "Factory Droid", format: "json", key: "mcpServers", entry: "standard",
    global: join(HOME, ".factory", "mcp.json"), project: ".factory/mcp.json",
    skillGlobal: join(HOME, ".factory", "skills"), skillProject: ".factory/skills",
  },
  {
    id: "kilo", label: "Kilo Code", format: "json", key: "mcp", entry: "local",
    global: join(HOME, ".config", "kilo", "kilo.json"), project: ".kilo/kilo.json",
    skillGlobal: join(HOME, ".kilo", "skills"), skillProject: ".kilo/skills",
  },
  {
    id: "continue", label: "Continue.dev", format: "yaml-file", entry: "continue",
    global: join(HOME, ".continue", "mcpServers", "chitta.yaml"), project: ".continue/mcpServers/chitta.yaml",
    detect: join(HOME, ".continue"),
    note: "writes a dedicated .continue/mcpServers/chitta.yaml block (Continue auto-loads it; config.yaml untouched).",
  },
  {
    id: "goose", label: "Goose", format: "yaml", key: "extensions", entry: "goose",
    global: join(HOME, ".config", "goose", "config.yaml"),
    note: "Block's Goose; merges into config.yaml's `extensions` (a .bak is written first — YAML comments aren't preserved).",
  },
  {
    id: "trae", label: "Trae", format: "json-array", key: "mcpServers", entry: "trae",
    global: null, skillProject: ".trae/skills",
    note: "Trae's global MCP file path is undocumented; add via the in-app MCP panel (use --print), Skill installs to .trae/skills.",
  },
]

export const byId = (id: string): Platform | undefined => PLATFORMS.find((p) => p.id === id)
