// `chitta learn <dir>` - walk a repository and turn it into PERMANENT memory.
//
// The one-off "analyze this folder" tools (Graphify et al.) parse a repo, hand you a
// report, and forget. Chitta ingests the same walk into the personal store the MCP
// server serves - code files go through the tree-sitter code extractor (36 grammars),
// docs through the deterministic text extractor - so the agent doesn't just get a
// report, it REMEMBERS the codebase across every future session. Re-running is
// idempotent: record ids are stable (`file:<relpath>`), so a re-learn supersedes the
// old contribution of each file instead of duplicating it.
//
// Zero-token like everything else: local embeddings + AST/rule extraction, no LLM.

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import type { EmbeddedContext } from "./index"
import { CodeExtractor } from "./extractors/code"

export interface LearnOptions {
  /** Safety cap on ingested files (default 2000); the walk reports what it skipped. */
  maxFiles?: number
  /** Skip files larger than this many bytes (default 200 KB - big blobs are rarely knowledge). */
  maxFileBytes?: number
  /** Progress callback, fired after each ingested file. */
  onProgress?: (done: number, total: number, relPath: string) => void
}

export interface LearnStats {
  root: string
  ingested: number
  codeFiles: number
  docFiles: number
  skipped: { dirs: number; large: number; binary: number; other: number; overCap: number }
  /** ingested-file count per language ("markdown"/"text" for docs). */
  languages: Record<string, number>
  /** store-level deltas (records / entities / relation edges) from this learn run. */
  delta: { records: number; entities: number; relations: number }
  /** most-connected concepts after the run (ACL-scoped), for the report. */
  hubs: Array<{ label: string; degree: number }>
  communities: number
  ms: number
}

// Directories that are dependency/build/VCS output, never knowledge. Any dot-directory
// is skipped too (.git, .next, .venv, .cache, ...) - dot FILES like .env are skipped by
// the extension filter anyway.
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "coverage", "vendor", "target",
  "__pycache__", "venv", ".git", "tmp", "logs",
])

// Docs worth remembering as prose (everything else must be a code extension).
const DOC_EXTS = new Set(["md", "mdx", "txt", "rst", "adoc"])

// Generated / lock / asset files - noise even when their extension looks textual.
const SKIP_FILES = [
  /^package-lock\.json$/i, /^bun\.lock\b/i, /^yarn\.lock$/i, /^pnpm-lock/i, /\.lock$/i,
  /\.min\.(js|css)$/i, /\.map$/i, /\.snap$/i,
  /\.(png|jpe?g|gif|webp|ico|svg|mp4|mov|avi|mp3|wav|zip|gz|tgz|bz2|7z|pdf|woff2?|ttf|otf|eot|wasm|db|sqlite|bin|exe|dylib|so|jar|class|pyc|onnx)$/i,
]

/** Null byte in the first 8 KB ⇒ binary. Cheap and language-agnostic. */
function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

/** What a path would be ingested as: a tree-sitter language, "markdown"/"text", or null. */
export function classifyFile(name: string): string | null {
  const base = name.split("/").pop() ?? name
  if (SKIP_FILES.some((re) => re.test(base))) return null
  const ext = base.toLowerCase().split(".").pop() ?? ""
  if (DOC_EXTS.has(ext)) return ext === "md" || ext === "mdx" ? "markdown" : "text"
  return CodeExtractor.detectLanguage(base) // null for anything we can't parse
}

/** Deterministic (sorted) walk: the files that WOULD be learned, plus skip counts. */
export function collectFiles(
  root: string,
  opts: LearnOptions = {},
): { files: Array<{ rel: string; lang: string }>; skipped: LearnStats["skipped"] } {
  const maxBytes = opts.maxFileBytes ?? 200_000
  const skipped = { dirs: 0, large: 0, binary: 0, other: 0, overCap: 0 }
  const files: Array<{ rel: string; lang: string }> = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir).sort()
    } catch {
      return // unreadable directory - skip, never crash a learn run
    }
    for (const name of entries) {
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue // broken symlink etc.
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name) || name.startsWith(".")) skipped.dirs++
        else walk(full)
        continue
      }
      if (!st.isFile()) continue
      const lang = classifyFile(name)
      if (!lang) {
        skipped.other++
        continue
      }
      if (st.size > maxBytes || st.size === 0) {
        skipped.large++
        continue
      }
      files.push({ rel: relative(root, full), lang })
    }
  }
  walk(root)
  return { files, skipped }
}

/** Walk `root` and ingest every learnable file into the store as this user's memory.
 *  Returns honest stats + the post-run graph shape for the report. */
export async function learnDirectory(
  ctx: EmbeddedContext,
  userId: string,
  orgId: string,
  root: string,
  opts: LearnOptions = {},
): Promise<LearnStats> {
  const t0 = performance.now()
  const maxFiles = opts.maxFiles ?? 2000
  const count = (sql: string): number => (ctx.store.db.query(sql).get() as { c: number }).c
  const before = {
    records: count("SELECT count(*) c FROM nodes WHERE coll='records'"),
    entities: count("SELECT count(*) c FROM nodes WHERE coll='entities'"),
    relations: count("SELECT count(*) c FROM edges WHERE label NOT IN ('mentions','permissions','belongsTo','inheritPermissions')"),
  }

  const { files, skipped } = collectFiles(root, opts)
  const toIngest = files.slice(0, maxFiles)
  skipped.overCap = files.length - toIngest.length

  const languages: Record<string, number> = {}
  let codeFiles = 0
  let docFiles = 0
  let done = 0
  for (const f of toIngest) {
    const buf = readFileSync(join(root, f.rel))
    if (isBinary(buf)) {
      skipped.binary++
      continue
    }
    await ctx.authorizedIngest(userId, {
      recordId: `file:${f.rel}`, // stable id ⇒ re-learn supersedes, never duplicates
      orgId,
      recordName: f.rel, // the extension here is what routes code through tree-sitter
      text: buf.toString("utf8"),
      permittedPrincipals: [userId],
    })
    languages[f.lang] = (languages[f.lang] ?? 0) + 1
    if (f.lang === "markdown" || f.lang === "text") docFiles++
    else codeFiles++
    done++
    opts.onProgress?.(done, toIngest.length, f.rel)
  }

  const [hubs, communities] = await Promise.all([
    ctx.graphQuery.central(userId, orgId, 8),
    ctx.graphQuery.communities(userId, orgId),
  ])
  return {
    root,
    ingested: done,
    codeFiles,
    docFiles,
    skipped,
    languages,
    delta: {
      records: count("SELECT count(*) c FROM nodes WHERE coll='records'") - before.records,
      entities: count("SELECT count(*) c FROM nodes WHERE coll='entities'") - before.entities,
      relations: count("SELECT count(*) c FROM edges WHERE label NOT IN ('mentions','permissions','belongsTo','inheritPermissions')") - before.relations,
    },
    hubs: hubs.map((h) => ({ label: h.label, degree: h.degree })).sort((a, b) => b.degree - a.degree),
    communities: Array.isArray(communities) ? communities.length : 0,
    ms: performance.now() - t0,
  }
}

/** Terminal report - what was learned, the shape of the graph, and what to ask next. */
export function renderLearnReport(s: LearnStats): string {
  const langs = Object.entries(s.languages)
    .sort((a, b) => b[1] - a[1])
    .map(([l, n]) => `${l} ${n}`)
    .join(" · ")
  const skippedTotal = s.skipped.large + s.skipped.binary + s.skipped.other + s.skipped.overCap
  const maxDeg = Math.max(1, ...s.hubs.map((h) => h.degree))
  const bar = (d: number): string => "▮".repeat(Math.max(1, Math.round((d / maxDeg) * 6)))
  const lines = [
    `Chitta learned ${s.root === "." ? "this repository" : s.root}`,
    "",
    `  files        ${s.ingested} ingested (${s.codeFiles} code · ${s.docFiles} docs) · ${skippedTotal} skipped (generated/binary/large)${s.skipped.overCap ? ` · ${s.skipped.overCap} over --max-files` : ""}`,
    `  languages    ${langs || "(none)"}`,
    `  graph        +${s.delta.records} records · +${s.delta.entities} concepts · +${s.delta.relations} relationships · ${s.communities} communities`,
    `  time         ${(s.ms / 1000).toFixed(1)}s · zero LLM tokens`,
  ]
  if (s.hubs.length > 0) {
    lines.push("", "  Most-connected concepts")
    for (const h of s.hubs.slice(0, 6)) lines.push(`    ${bar(h.degree)} ${h.label} · ${h.degree}`)
    const [a, b] = s.hubs
    lines.push(
      "",
      "  Your agent now remembers this - ask it things like",
      `    · "what do you know about ${a?.label ?? "this repo"}?"`,
      ...(a && b ? [`    · "how are ${a.label} and ${b.label} connected?"`] : []),
      `    · "what would break if we changed ${a?.label ?? "the core module"}?"`,
    )
  }
  lines.push("", "  → chitta graph --open   to see everything it knows")
  return lines.join("\n")
}
