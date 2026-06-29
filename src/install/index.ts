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
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { PLATFORMS, byId, type Platform } from "./platforms"
import { serverEntry, writeJsonConfig, writeCodexToml, printSnippet } from "./writers"
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

function doInstall(p: Platform): string {
  const skillDir = targetSkillDir(p)
  const skillNote = skillDir ? `  + skill → ${installSkill(skillDir)}` : ""
  if (p.format === "manual" || (!project && p.global === null)) {
    return `~ ${p.label}: no stable config path — add manually (see --print).${skillNote}`
  }
  const path = targetConfigPath(p)
  if (!path) return `~ ${p.label}: no ${project ? "project" : "global"} config path.${skillNote}`
  if (p.format === "toml") {
    writeCodexToml(path, env)
  } else {
    writeJsonConfig(path, p.key!, serverEntry(p.entry!, env), p.format === "json-array")
  }
  return `✓ ${p.label} → ${path}${p.note ? `\n    (${p.note})` : ""}${skillNote}`
}

function doUninstall(p: Platform): string {
  const path = targetConfigPath(p)
  const lines: string[] = []
  if (path && existsSync(path)) {
    if (p.format === "toml") {
      const t = readFileSync(path, "utf8").replace(/\n*\[mcp_servers\.chitta\][\s\S]*?(?=\n\[[^.\]]|\s*$)/g, "\n")
      writeFileSync(path, t.replace(/\n{3,}/g, "\n\n").trimStart())
    } else {
      try {
        const cfg = JSON.parse(readFileSync(path, "utf8"))
        const c = cfg[p.key!]
        if (Array.isArray(c)) cfg[p.key!] = c.filter((e: any) => e?.name !== "chitta")
        else if (c && typeof c === "object") delete c["chitta"]
        writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n")
      } catch { /* ignore malformed */ }
    }
    lines.push(`✓ removed from ${path}`)
  }
  const skillDir = targetSkillDir(p)
  if (skillDir && existsSync(join(skillDir, "chitta"))) {
    rmSync(join(skillDir, "chitta"), { recursive: true, force: true })
    lines.push(`✓ removed skill ${join(skillDir, "chitta")}`)
  }
  return `${p.label}:\n  ${lines.length ? lines.join("\n  ") : "(nothing to remove)"}`
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
console.log(`Chitta ${action} — ${project ? "project" : "global"} scope${project ? ` (${projectDir})` : ""}\n`)
for (const p of platforms) console.log(run(p) + "\n")
if (action === "install") {
  console.log("Done. Restart the tool (or reload its MCP config) to pick up Chitta's tools:")
  console.log("  context_ingest · get_context · context_graph")
}
