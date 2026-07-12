// Config writers — one per FORMAT, not per tool. Each MERGES into existing config so other
// MCP servers and unrelated settings are preserved, and re-running is idempotent. Every write
// goes through writeIfChanged: an already-correct config is left byte-for-byte alone (no churn,
// no backup spam), and an existing file is backed up before it is ever overwritten.
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs"
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
    case "goose": // Block's Goose: `extensions` map keyed by name; uses cmd/args + `envs`
      return { enabled: true, type: "stdio", name: "chitta", cmd: "bunx", args: [PKG], timeout: 300, envs: env }
    case "continue": // Continue.dev: one item in the config's `mcpServers` list
      return { name: "chitta", ...cmd, ...(hasEnv ? { env } : {}) }
  }
}

// ── file safety ──────────────────────────────────────────────────────────────────
/** Back up `path` to a sibling. The first backup is `<path>.bak`; later ones are timestamped so a
 *  prior backup is never clobbered. Returns the backup path. */
function backupFile(path: string): string {
  let bak = `${path}.bak`
  if (existsSync(bak)) bak = `${path}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`
  copyFileSync(path, bak)
  return bak
}

/** Write `content` only if it differs from what's on disk, backing up the existing file first.
 *  Returns the backup path, or null if the file was new or already up to date. */
export function writeIfChanged(path: string, content: string): string | null {
  const existed = existsSync(path)
  if (existed && readFileSync(path, "utf8") === content) return null // already correct → no-op
  mkdirSync(dirname(path), { recursive: true })
  const bak = existed ? backupFile(path) : null
  writeFileSync(path, content)
  return bak
}

/** Shared merge: replace-or-insert the chitta entry under `key`, keeping everything else. */
function mergeEntry(cfg: any, key: string, entry: unknown, array: boolean): void {
  if (array) {
    const list = Array.isArray(cfg[key]) ? cfg[key] : []
    cfg[key] = list.filter((e: any) => e?.name !== "chitta")
    cfg[key].push(entry)
  } else {
    if (typeof cfg[key] !== "object" || cfg[key] === null || Array.isArray(cfg[key])) cfg[key] = {}
    cfg[key]["chitta"] = entry
  }
}

/** Remove chitta from a parsed config under `key`. Returns true if something was removed. */
function removeEntry(cfg: any, key: string): boolean {
  const c = cfg?.[key]
  if (Array.isArray(c)) {
    const kept = c.filter((e: any) => e?.name !== "chitta")
    cfg[key] = kept
    return kept.length !== c.length
  }
  if (c && typeof c === "object" && "chitta" in c) {
    delete c["chitta"]
    return true
  }
  return false
}

// ── JSON (most tools) ──────────────────────────────────────────────────────────────
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

/** Merge `chitta` into a JSON config under `key`. Object form (most tools) or array form (Trae).
 *  Returns the backup path if an existing file was overwritten. */
export function writeJsonConfig(path: string, key: string, entry: unknown, array: boolean): string | null {
  const cfg = readJson(path)
  mergeEntry(cfg, key, entry, array)
  return writeIfChanged(path, JSON.stringify(cfg, null, 2) + "\n")
}

/** Remove chitta from a JSON config. Returns true if something was removed. */
export function removeJsonConfig(path: string, key: string): boolean {
  if (!existsSync(path)) return false
  let cfg: any
  try { cfg = readJson(path) } catch { return false } // malformed → leave it untouched
  if (!removeEntry(cfg, key)) return false
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n")
  return true
}

// ── YAML (Goose, Continue.dev) ──────────────────────────────────────────────────────
// Chitta runs on Bun, so we use the runtime's native `Bun.YAML` (parse tolerates comments;
// stringify emits clean block style). A merge re-serializes the whole file, so YAML comments
// are not preserved — writeIfChanged backs the original up first so nothing is lost.
function readYaml(path: string): any {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, "utf8").trim()
  if (!raw) return {}
  const parsed = Bun.YAML.parse(raw) // throws on malformed → caller records a failure, file untouched
  if (parsed == null) return {}
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("existing YAML is not a mapping")
  return parsed
}

// Serialize to clean block YAML. Bun leaves trailing spaces after parent keys ("foo: ");
// they're valid YAML but we strip them (never significant in block style) for tidy files.
const toYaml = (obj: unknown): string => Bun.YAML.stringify(obj, null, 2).replace(/ +$/gm, "").trimEnd() + "\n"

/** Merge `chitta` into a YAML config under `key` (object or array form). */
export function writeYamlConfig(path: string, key: string, entry: unknown, array: boolean): string | null {
  const cfg = readYaml(path)
  mergeEntry(cfg, key, entry, array)
  return writeIfChanged(path, toYaml(cfg))
}

/** Write a dedicated standalone YAML block file (Continue.dev's `.continue/mcpServers/chitta.yaml`).
 *  We own the whole file, so this just overwrites it — inherently idempotent. */
export function writeYamlFile(path: string, entry: unknown): string | null {
  return writeIfChanged(path, toYaml({ name: "Chitta", version: "0.0.1", schema: "v1", mcpServers: [entry] }))
}

/** Remove chitta from a YAML config. Returns true if something was removed. */
export function removeYamlConfig(path: string, key: string): boolean {
  if (!existsSync(path)) return false
  let cfg: any
  try { cfg = readYaml(path) } catch { return false }
  if (!removeEntry(cfg, key)) return false
  writeFileSync(path, toYaml(cfg))
  return true
}

// ── Codex TOML ─────────────────────────────────────────────────────────────────────
const TOML_CHITTA = /\n*\[mcp_servers\.chitta\][\s\S]*?(?=\n\[[^.\]]|\n\[mcp_servers\.(?!chitta)|\s*$)/g

/** Codex TOML: replace-or-append the [mcp_servers.chitta] block (+ optional env table). */
export function writeCodexToml(path: string, env: Record<string, string>): string | null {
  let text = existsSync(path) ? readFileSync(path, "utf8") : ""
  // strip any existing chitta block (the table + its sub-tables up to the next top-level [table])
  text = text.replace(TOML_CHITTA, "\n").replace(/\n{3,}/g, "\n\n").trimEnd()
  let block = `\n\n[mcp_servers.chitta]\ncommand = "bunx"\nargs = ["${PKG}"]\n`
  const keys = Object.keys(env)
  if (keys.length) {
    block += `\n[mcp_servers.chitta.env]\n`
    for (const k of keys) block += `${k} = ${JSON.stringify(env[k])}\n`
  }
  return writeIfChanged(path, (text + block).trimStart() + "\n")
}

/** Remove the [mcp_servers.chitta] block from a Codex TOML file. Returns true if it changed. */
export function removeCodexToml(path: string): boolean {
  if (!existsSync(path)) return false
  const orig = readFileSync(path, "utf8")
  const stripped = orig.replace(TOML_CHITTA, "\n").replace(/\n{3,}/g, "\n\n").trimStart()
  const out = stripped ? (stripped.endsWith("\n") ? stripped : stripped + "\n") : ""
  if (out === orig) return false
  writeFileSync(path, out)
  return true
}

/** The generic snippet for --print / unsupported clients. */
export function printSnippet(env: Record<string, string>): string {
  return JSON.stringify({ mcpServers: { chitta: serverEntry("standard", env) } }, null, 2)
}
