// Config writers — one per FORMAT, not per tool. Each MERGES into existing config so other
// MCP servers and unrelated settings are preserved, and re-running is idempotent.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname } from "node:path"
import type { Entry } from "./platforms"

export const PKG = "@100xprompt/chitta"
// Chitta runs on the Bun runtime, so it launches via `bunx` (Bun's package runner).
// Users need Bun once: `curl -fsSL https://bun.sh/install | bash`.
const RUN = ["bunx", PKG] // [command, ...args]

/** Build the server-entry object in the dialect a given tool expects. */
export function serverEntry(entry: Entry, env: Record<string, string>): unknown {
  const hasEnv = Object.keys(env).length > 0
  const cmd = { command: "bunx", args: [PKG] }
  switch (entry) {
    case "standard":
      return { ...cmd, ...(hasEnv ? { env } : {}) }
    case "vscode":
      return { type: "stdio", ...cmd, ...(hasEnv ? { env } : {}) }
    case "zed":
      return { source: "custom", ...cmd, ...(hasEnv ? { env } : {}) }
    case "local": // opencode / kilo: combined command array + `environment` + enabled
      return { type: "local", command: [...RUN], enabled: true, ...(hasEnv ? { environment: env } : {}) }
    case "trae": // array entry carrying its own name + combined command array
      return { name: "chitta", command: [...RUN], ...(hasEnv ? { env } : {}) }
  }
}

function readJson(path: string): any {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, "utf8").trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    // tolerate JSONC line comments (VS Code / opencode allow them)
    return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""))
  }
}

/** Merge `chitta` into a JSON config under `key`. Object form (most tools) or array form (Trae). */
export function writeJsonConfig(
  path: string,
  key: string,
  entry: unknown,
  array: boolean,
): void {
  mkdirSync(dirname(path), { recursive: true })
  const cfg = readJson(path)
  if (array) {
    const list = Array.isArray(cfg[key]) ? cfg[key] : []
    const filtered = list.filter((e: any) => e?.name !== "chitta")
    filtered.push(entry)
    cfg[key] = filtered
  } else {
    if (typeof cfg[key] !== "object" || cfg[key] === null || Array.isArray(cfg[key])) cfg[key] = {}
    cfg[key]["chitta"] = entry
  }
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n")
}

/** Codex TOML: replace-or-append the [mcp_servers.chitta] block (+ optional env table). */
export function writeCodexToml(path: string, env: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true })
  let text = existsSync(path) ? readFileSync(path, "utf8") : ""
  // strip any existing chitta block (the table + its sub-tables up to the next top-level [table])
  text = text.replace(/\n*\[mcp_servers\.chitta\][\s\S]*?(?=\n\[[^.\]]|\n\[mcp_servers\.(?!chitta)|\s*$)/g, "\n")
  text = text.replace(/\n{3,}/g, "\n\n").trimEnd()
  let block = `\n\n[mcp_servers.chitta]\ncommand = "bunx"\nargs = ["${PKG}"]\n`
  const keys = Object.keys(env)
  if (keys.length) {
    block += `\n[mcp_servers.chitta.env]\n`
    for (const k of keys) block += `${k} = ${JSON.stringify(env[k])}\n`
  }
  writeFileSync(path, (text + block).trimStart() + "\n")
}

/** The generic snippet for --print / unsupported clients. */
export function printSnippet(env: Record<string, string>): string {
  return JSON.stringify({ mcpServers: { chitta: serverEntry("standard", env) } }, null, 2)
}
