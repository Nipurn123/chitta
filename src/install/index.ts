// `chitta install` — wire Chitta into AI tools as an MCP server (everywhere) and a Skill
// (where supported). One command; merges into existing config; idempotent.
//
//   chitta install                         # auto-detect installed tools (global), install to each
//   chitta install --platform cursor,zed   # specific tools
//   chitta install --all                    # every supported tool
//   chitta install --platform claude-code --project [--project-dir .]   # project-scoped
//   chitta install --print                  # print the generic MCP snippet, write nothing
//   chitta install --list                   # list supported tools
//   chitta install --user-id alice --org-id acme   # bake identity into the config env
//   chitta uninstall [--platform ...] [--project]   # remove the chitta entry/skill
import { existsSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { PLATFORMS, byId, type Platform } from "./platforms"
import {
  serverEntry, printSnippet,
  writeJsonConfig, writeYamlConfig, writeYamlFile, writeCodexToml,
  removeJsonConfig, removeYamlConfig, removeCodexToml,
} from "./writers"
import { installSkill } from "./skill"

const argv = process.argv.slice(2)
const action = argv[0] // "install" | "uninstall"
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined
}
const has = (name: string) => argv.includes(`--${name}`)

// Every config knob is an env var that the installer bakes into the tool's MCP `env` block
// (serverEntry writes it in each tool's dialect). One flag → one env var, so configuring
// Chitta at install time is the same for all 15 tools.
const ENV_FLAGS: Record<string, string> = {
  "user-id": "CONTEXT_USER_ID",
  "org-id": "CONTEXT_ORG_ID",
  role: "CONTEXT_USER_ROLE", // admin | editor | viewer
  groups: "CONTEXT_USER_GROUPS", // comma-separated
  db: "CONTEXT_DB", // store path
  embeddings: "CONTEXT_EMBEDDINGS", // auto | real | hash
  "embed-model": "CONTEXT_EMBED_MODEL",
  "memory-ttl": "CONTEXT_MEMORY_TTL_DAYS",
  "db-key": "CONTEXT_DB_KEY", // encryption at rest
  topk: "CONTEXT_TOPK",
  "llm-url": "CONTEXT_LLM_URL",
  "llm-model": "CONTEXT_LLM_MODEL",
  rerank: "CONTEXT_RERANK", // 0 to disable
}
const env: Record<string, string> = {}
for (const [f, e] of Object.entries(ENV_FLAGS)) {
  const v = flag(f)
  if (v !== undefined) env[e] = v
}
if (has("audit")) env.CHITTA_AUDIT = "1" // boolean toggle
if (has("encrypt") && !env.CONTEXT_DB_KEY) {
  console.error("--encrypt needs a key: pass --db-key <key> (encryption reads CONTEXT_DB_KEY at runtime).")
  process.exit(1)
}
if (env.CONTEXT_DB_KEY) {
  console.error(
    "⚠ security: --db-key writes the encryption key into the tool's MCP config file in plaintext.\n" +
      "  Restrict that file (chmod 600) or instead set CONTEXT_DB_KEY via your client's secret store.\n" +
      "  Also install the encrypted driver once: bun add libsql\n",
  )
}

const project = has("project")
const projectDir = resolve(flag("project-dir") ?? ".")
const withSkill = !has("no-skill")

function targetConfigPath(p: Platform): string | null {
  if (project) return p.project ? join(projectDir, p.project) : null
  return p.global
}
function targetSkillDir(p: Platform): string | null {
  if (!withSkill) return null
  if (project) return p.skillProject ? join(projectDir, p.skillProject) : null
  return p.skillGlobal ?? null
}

/** A tool counts as "present" if its config dir/file already exists on this machine. */
function detected(p: Platform): boolean {
  if (p.detect) return existsSync(p.detect) // explicit probe (tool home) when the config lives in a lazy subdir
  if (!p.global) return false
  return existsSync(p.global) || existsSync(dirname(p.global))
}

function resolvePlatforms(): Platform[] {
  if (has("all")) return PLATFORMS
  const csv = flag("platform")
  if (csv) {
    const ids = csv.split(",").map((s) => s.trim()).filter(Boolean)
    const out: Platform[] = []
    for (const id of ids) {
      const p = byId(id)
      if (!p) { console.error(`unknown platform "${id}" — run \`chitta install --list\``); process.exit(1) }
      out.push(p)
    }
    return out
  }
  // no --platform: project mode defaults to Claude Code; global mode auto-detects.
  if (project) return [byId("claude-code")!]
  const found = PLATFORMS.filter(detected)
  if (found.length === 0) {
    console.error("No supported AI tools detected. Use --platform <id> or --all, or --list.")
    process.exit(1)
  }
  return found
}

// One tool's outcome. `text` is the human block printed for it; the rest feeds the summary.
interface Report {
  label: string
  status: "ok" | "skip" | "fail"
  path?: string | null
  backup?: string | null
  reason?: string
  text: string
}
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function doInstall(p: Platform): Report {
  // Skill install is isolated: a skills-dir failure is reported but never sinks a good config write.
  const skillDir = targetSkillDir(p)
  let skillNote = ""
  if (skillDir) {
    try { skillNote = `\n    + skill → ${installSkill(skillDir)}` }
    catch (e) { skillNote = `\n    ! skill install failed: ${errMsg(e)}` }
  }
  if (p.format === "manual" || (!project && p.global === null)) {
    return { label: p.label, status: "skip", reason: "no stable config path (see --print)",
      text: `~ ${p.label}: no stable config path — add manually (see --print).${skillNote}` }
  }
  const path = targetConfigPath(p)
  if (!path) {
    return { label: p.label, status: "skip", reason: `no ${project ? "project" : "global"} config path`,
      text: `~ ${p.label}: no ${project ? "project" : "global"} config path.${skillNote}` }
  }
  let backup: string | null = null
  if (p.format === "toml") backup = writeCodexToml(path, env)
  else if (p.format === "yaml") backup = writeYamlConfig(path, p.key!, serverEntry(p.entry!, env), false)
  else if (p.format === "yaml-file") backup = writeYamlFile(path, serverEntry(p.entry!, env))
  else backup = writeJsonConfig(path, p.key!, serverEntry(p.entry!, env), p.format === "json-array")
  const noteLine = p.note ? `\n    (${p.note})` : ""
  const backLine = backup ? `\n    ↺ backed up prior config → ${backup}` : ""
  return { label: p.label, status: "ok", path, backup, text: `✓ ${p.label} → ${path}${noteLine}${backLine}${skillNote}` }
}

function doUninstall(p: Platform): Report {
  const path = targetConfigPath(p)
  const lines: string[] = []
  let status: Report["status"] = "skip"
  if (path && existsSync(path)) {
    if (p.format === "yaml-file") {
      rmSync(path, { force: true }) // a file we fully own → delete outright
      lines.push(`✓ removed ${path}`); status = "ok"
    } else {
      const removed = p.format === "toml" ? removeCodexToml(path)
        : p.format === "yaml" ? removeYamlConfig(path, p.key!)
        : removeJsonConfig(path, p.key!)
      if (removed) { lines.push(`✓ removed from ${path}`); status = "ok" }
    }
  }
  const skillDir = targetSkillDir(p)
  if (skillDir && existsSync(join(skillDir, "chitta"))) {
    rmSync(join(skillDir, "chitta"), { recursive: true, force: true })
    lines.push(`✓ removed skill ${join(skillDir, "chitta")}`); status = "ok"
  }
  return { label: p.label, status, text: `${p.label}:\n  ${lines.length ? lines.join("\n  ") : "(nothing to remove)"}` }
}

/** Per-tool ✓/~/✗ roll-up printed after all tools run. */
function printSummary(reports: Report[], verb: string): void {
  const n = (s: Report["status"]) => reports.filter((r) => r.status === s).length
  console.log("─".repeat(56))
  console.log(`Summary — ${verb}: ${n("ok")} ok · ${n("skip")} skipped · ${n("fail")} failed`)
  for (const r of reports) {
    const mark = r.status === "ok" ? "✓" : r.status === "skip" ? "~" : "✗"
    const tail = r.status === "ok" ? (r.path ?? "") : (r.reason ?? "")
    console.log(`  ${mark} ${r.label.padEnd(16)} ${tail}${r.backup ? `  [backup ${r.backup}]` : ""}`)
  }
}

// ── main ───────────────────────────────────────────────────────────────────────
if (has("list")) {
  console.log("Supported platforms:\n")
  for (const p of PLATFORMS) {
    const tags = [p.skillGlobal || p.skillProject ? "skill" : "", p.format].filter(Boolean).join(", ")
    console.log(`  ${p.id.padEnd(15)} ${p.label.padEnd(22)} (${tags})`)
  }
  console.log(`\nUsage: chitta install --platform <id>[,<id>...] | --all   [--project]`)
  console.log("\nConfiguration flags (baked into the tool's MCP env block):")
  console.log("  --user-id <id> --org-id <id>     identity (drives ACL)")
  console.log("  --role <admin|editor|viewer>     --groups <a,b,c>")
  console.log("  --db <path>                      store location")
  console.log("  --embeddings <auto|real|hash>    --embed-model <name>")
  console.log("  --db-key <key>                   encryption at rest (needs `bun add libsql`)")
  console.log("  --audit                          enable tamper-evident audit logging")
  console.log("  --memory-ttl <days>              auto-forget dynamic memories after N days")
  console.log("  --llm-url <url> [--llm-model m]   typed-triple extraction + KGQA via a local LLM")
  console.log("  --topk <n>   --rerank 0          retrieval breadth / disable reranker")
  console.log("\nInspect current config any time:  chitta doctor")
  process.exit(0)
}

if (has("print")) {
  console.log("Add this to your MCP client's config (key is usually `mcpServers`):\n")
  console.log(printSnippet(env))
  process.exit(0)
}

const platforms = resolvePlatforms()
const run = action === "uninstall" ? doUninstall : doInstall
const verb = action === "uninstall" ? "uninstall" : "install"
console.log(`Chitta ${verb} — ${project ? "project" : "global"} scope${project ? ` (${projectDir})` : ""}\n`)
const reports: Report[] = []
for (const p of platforms) {
  let r: Report
  try {
    r = run(p)
  } catch (e) {
    // partial-failure isolation: one tool's error (perms, malformed config, …) never aborts the rest
    const reason = errMsg(e)
    r = { label: p.label, status: "fail", reason, text: `✗ ${p.label}: ${reason}` }
  }
  console.log(r.text + "\n")
  reports.push(r)
}
printSummary(reports, verb)
const failed = reports.filter((r) => r.status === "fail").length
if (action === "install" && reports.some((r) => r.status === "ok")) {
  console.log("\nDone. Restart the tool (or reload its MCP config) to pick up Chitta's tools:")
  console.log("  get_context · context_ingest · context_forget · context_profile · context_graph · context_relate")
  console.log("Tip: `chitta doctor` shows your config + health.")
}
if (failed) {
  console.log(`\n${failed} tool(s) failed — see the ✗ line(s) above; the rest completed.`)
  process.exitCode = 1 // signal partial failure to scripts/CI without swallowing output
}
