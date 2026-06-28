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

const env: Record<string, string> = {}
if (flag("user-id")) env.CONTEXT_USER_ID = flag("user-id")!
if (flag("org-id")) env.CONTEXT_ORG_ID = flag("org-id")!

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
  console.log(`\nUsage: chitta install --platform <id>[,<id>...] | --all   [--project] [--user-id X --org-id Y]`)
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
