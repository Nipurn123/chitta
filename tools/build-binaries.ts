// Build the publishable npm artifacts for `npx @100xprompt/chitta`:
//   dist-npm/chitta/                      → main package (Node shim + optionalDependencies)
//   dist-npm/chitta-<os>-<arch>/          → platform packages, each a bun-compiled binary
//
//   bun run tools/build-binaries.ts             # build all targets
//   bun run tools/build-binaries.ts darwin-arm64 linux-x64   # subset
//
// Then publish (platform packages FIRST, main LAST, identical version):
//   for d in dist-npm/chitta-*; do (cd "$d" && npm publish); done
//   (cd dist-npm/chitta && npm publish)
import { $ } from "bun"
import { mkdirSync, writeFileSync, copyFileSync, chmodSync, existsSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const OUT = join(ROOT, "dist-npm")
const VERSION = JSON.parse(await Bun.file(join(ROOT, "package.json")).text()).version as string
const SCOPE = "@100xprompt"

interface Target { id: string; os: string; cpu: string; bunTarget: string; bin: string }
const TARGETS: Target[] = [
  { id: "darwin-arm64", os: "darwin", cpu: "arm64", bunTarget: "bun-darwin-arm64", bin: "chitta" },
  { id: "darwin-x64", os: "darwin", cpu: "x64", bunTarget: "bun-darwin-x64", bin: "chitta" },
  { id: "linux-x64", os: "linux", cpu: "x64", bunTarget: "bun-linux-x64", bin: "chitta" },
  { id: "linux-arm64", os: "linux", cpu: "arm64", bunTarget: "bun-linux-arm64", bin: "chitta" },
  { id: "win32-x64", os: "win32", cpu: "x64", bunTarget: "bun-windows-x64", bin: "chitta.exe" },
]

const wanted = process.argv.slice(2)
const targets = wanted.length ? TARGETS.filter((t) => wanted.includes(t.id)) : TARGETS

mkdirSync(OUT, { recursive: true })

// ── platform packages (each: one compiled binary) ───────────────────────────────
for (const t of targets) {
  const dir = join(OUT, `chitta-${t.id}`)
  mkdirSync(dir, { recursive: true })
  const outfile = join(dir, t.bin)
  console.log(`compiling ${t.id} → ${outfile}`)
  // @huggingface/transformers & @xenova/transformers are OPTIONAL runtime deps behind a
  // try/catch; keep them external so --compile doesn't try to bundle an absent package.
  const args = [
    "build", "--compile", "--minify", `--target=${t.bunTarget}`,
    "--external", "@huggingface/transformers", "--external", "@xenova/transformers",
    join(ROOT, "src/bin.ts"), "--outfile", outfile,
  ]
  await $`bun ${args}`.quiet()
  if (t.os !== "win32") chmodSync(outfile, 0o755)
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: `${SCOPE}/chitta-${t.id}`, version: VERSION,
    description: `Chitta binary for ${t.id}`,
    os: [t.os], cpu: [t.cpu], files: [t.bin],
    publishConfig: { access: "public" },
    license: "MIT",
  }, null, 2) + "\n")
}

// ── main package (Node shim + optionalDependencies + bundled SKILL.md) ───────────
const main = join(OUT, "chitta")
mkdirSync(join(main, "assets", "skill"), { recursive: true })
copyFileSync(join(ROOT, "npm", "shim.cjs"), join(main, "shim.cjs"))
copyFileSync(join(ROOT, "assets", "skill", "SKILL.md"), join(main, "assets", "skill", "SKILL.md"))
if (existsSync(join(ROOT, "README.md"))) copyFileSync(join(ROOT, "README.md"), join(main, "README.md"))
const optionalDependencies: Record<string, string> = {}
for (const t of TARGETS) optionalDependencies[`${SCOPE}/chitta-${t.id}`] = VERSION
writeFileSync(join(main, "package.json"), JSON.stringify({
  name: `${SCOPE}/chitta`, version: VERSION,
  description: "Chitta - permission-aware memory for AI agents (MCP server + installer). By 100xprompt.",
  bin: { chitta: "shim.cjs" },
  files: ["shim.cjs", "assets"],
  keywords: ["mcp", "mcp-server", "ai-memory", "agent-memory", "knowledge-graph", "rag", "permission-aware", "rbac"],
  license: "MIT",
  publishConfig: { access: "public" },
  optionalDependencies,
}, null, 2) + "\n")

console.log(`\n✓ built ${targets.length} platform package(s) + main → ${OUT}`)
console.log("Publish: platform packages first, then dist-npm/chitta (same version).")
