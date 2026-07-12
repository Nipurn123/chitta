// Cross-session agent memory — the ONE "aha": your AI coding agent REMEMBERS across sessions.
//
//   Run the whole thing (two real processes, one file):   ./run.sh
//   Or a single process (session 1 then session 2):        bun run demo.ts
//   Or drive one side at a time:                           bun run demo.ts session1
//                                                          bun run demo.ts session2
//
// hash embedder + rerank off  ⇒  offline, deterministic, zero tokens, no model downloads.

import { existsSync, rmSync } from "node:fs"
import { Chitta } from "@100xprompt/chitta"

// ── the persistent store: a REAL file on disk, not ":memory:" ──────────────────
const DB = process.env.CHITTA_DEMO_DB ?? new URL("./agent-memory.db", import.meta.url).pathname

// ── tiny terminal styling (no deps) ────────────────────────────────────────────
const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", gray: "\x1b[90m",
}
const paint = (s: string, ...codes: string[]) => codes.join("") + s + C.reset
const rule = (ch = "─") => C.gray + ch.repeat(66) + C.reset
function banner(title: string, subtitle?: string) {
  console.log()
  console.log(rule("━"))
  console.log("  " + paint(title, C.bold, C.cyan) + (subtitle ? "  " + paint(subtitle, C.dim) : ""))
  console.log(rule("━"))
}

// ── what SESSION 1 teaches the agent: realistic project facts + a preference ────
// Each memory carries a precise TYPED graph (entities + relations) — the zero-token
// path: no second model re-reads the text, the triples are stored exactly.
const MEMORIES: Array<{
  text: string; name: string
  entities: Array<{ name: string; type?: string }>
  relations: Array<{ from: string; to: string; type: string }>
}> = [
  {
    text: "Chitta runs on Bun and stores everything in bun:sqlite — no servers, fully local.",
    name: "tech-stack",
    entities: [{ name: "Chitta", type: "PROJECT" }, { name: "Bun", type: "RUNTIME" }, { name: "bun:sqlite", type: "DATABASE" }],
    relations: [{ from: "Chitta", to: "Bun", type: "runs_on" }, { from: "Chitta", to: "bun:sqlite", type: "stores_data_in" }],
  },
  {
    text: "The retrieval entrypoint is searchWithGraph, wired up in the hybrid retriever; it blends vector, keyword, and graph search.",
    name: "retrieval-entrypoint",
    entities: [{ name: "Chitta", type: "PROJECT" }, { name: "searchWithGraph", type: "FUNCTION" }, { name: "hybrid retriever", type: "MODULE" }],
    relations: [{ from: "Chitta", to: "searchWithGraph", type: "retrieves_with" }, { from: "searchWithGraph", to: "hybrid retriever", type: "defined_in" }],
  },
  {
    text: "We chose SQLite over Postgres so the memory layer stays zero-config and local-first.",
    name: "db-decision",
    entities: [{ name: "Chitta", type: "PROJECT" }, { name: "SQLite", type: "DATABASE" }, { name: "Postgres", type: "DATABASE" }],
    relations: [{ from: "Chitta", to: "SQLite", type: "built_on" }],
  },
  {
    text: "Nipurn prefers TypeScript with 2-space indentation and no semicolons.",
    name: "code-style",
    entities: [{ name: "Nipurn", type: "PERSON" }, { name: "TypeScript", type: "LANGUAGE" }],
    relations: [{ from: "Nipurn", to: "TypeScript", type: "prefers" }, { from: "Chitta", to: "TypeScript", type: "written_in" }],
  },
  {
    text: "Run the test suite with `bun test test/`; the embedded SDK tests live in test/embedded.",
    name: "how-to-test",
    entities: [{ name: "Chitta", type: "PROJECT" }, { name: "bun test", type: "COMMAND" }],
    relations: [{ from: "Chitta", to: "bun test", type: "tested_with" }],
  },
]

// ── the natural-language questions SESSION 2 asks a fresh process ────────────────
const QUESTIONS = [
  "what does Chitta run on?",
  "where is the retrieval entrypoint?",
  "what indentation does Nipurn prefer?",
  "what did we choose for zero-config local-first storage?",
]

// ════════════════════════════════════════════════════════════════════════════════
// SESSION 1 — the agent learns, then the process exits (store closes).
// ════════════════════════════════════════════════════════════════════════════════
async function runSession1() {
  // fresh slate for a clean demo run
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (existsSync(f)) rmSync(f)

  banner("SESSION 1", "the agent is working on the project and learns a few things")
  console.log(`  ${paint("persistent store:", C.dim)} ${paint(DB, C.yellow)}\n`)

  const mem = new Chitta({ path: DB, embeddings: "hash", rerank: false })
  for (const m of MEMORIES) {
    await mem.remember(m.text, { name: m.name, entities: m.entities, relations: m.relations })
    console.log(`  ${paint("remembered", C.green)}  ${m.text}`)
  }

  const info = mem.about()
  console.log(`\n  ${paint("→ persisted to disk:", C.bold)} ${info.records} records · ${info.entities} entities · ${info.chunks} chunks`)
  mem.close() // the session ends — the DB connection is closed
  console.log(`  ${paint("→ session closed. the agent's process is gone.", C.dim)}`)
}

// ════════════════════════════════════════════════════════════════════════════════
// SESSION 2 — a BRAND NEW process/instance opens the SAME file and remembers.
// ════════════════════════════════════════════════════════════════════════════════
async function runSession2() {
  if (!existsSync(DB)) {
    console.error(paint(`\n  no store at ${DB} — run session 1 first (or just: bun run demo.ts)\n`, C.red))
    process.exit(1)
  }

  banner("SESSION 2", "a fresh process, a brand-new Chitta instance, the SAME file")

  // BEFORE — a fresh agent with NO memory (an empty, in-memory store).
  console.log(`\n  ${paint("BEFORE", C.bold, C.red)} ${paint("— a brand-new agent, no memory of the last session:", C.dim)}`)
  const blank = new Chitta({ embeddings: "hash", rerank: false }) // ":memory:" ⇒ empty
  {
    const q = QUESTIONS[0]
    const hits = await blank.recall(q)
    console.log(`     ${paint("Q:", C.gray)} ${q}`)
    console.log(`     ${paint("A:", C.gray)} ${paint(hits.length ? hits[0].text : "¯\\_(ツ)_/¯  I have no idea — I just started up.", C.red)}`)
  }
  blank.close()

  // AFTER — the SAME questions, answered from the persisted file.
  console.log(`\n  ${paint("AFTER", C.bold, C.green)} ${paint("— …but Chitta remembered. Same file, new process:", C.dim)}`)
  const mem = new Chitta({ path: DB, embeddings: "hash", rerank: false })
  const info = mem.about()
  console.log(`     ${paint(`loaded ${info.records} records · ${info.entities} entities from disk`, C.dim)}\n`)

  for (const q of QUESTIONS) {
    const hits = await mem.recall(q, { limit: 2 })
    const top = hits[0]
    console.log(`     ${paint("Q:", C.cyan)} ${paint(q, C.bold)}`)
    if (top) {
      console.log(`     ${paint("A:", C.green)} ${top.text}  ${paint(`(score ${top.score.toFixed(3)})`, C.gray)}`)
    } else {
      console.log(`     ${paint("A: (nothing found)", C.red)}`)
    }
    console.log()
  }

  // ── THE KNOWLEDGE GRAPH the agent built, reconstructed from disk ──
  await printGraph(mem)
  mem.close()
}

// ── render the typed knowledge graph so the structure is VISIBLE ─────────────────
async function printGraph(mem: Chitta) {
  banner("THE KNOWLEDGE GRAPH", "entities + typed relations, rebuilt from the file")

  // Most-connected concepts — what the agent knows most about.
  const central = await mem.graph.central(6)
  console.log(`\n  ${paint("Most-connected concepts", C.bold)} ${paint("(degree = typed edges)", C.dim)}`)
  for (const c of central) {
    const bar = "▮".repeat(Math.max(1, c.degree))
    console.log(`     ${paint(bar, C.magenta)} ${paint(c.label, C.bold)} ${paint(`· ${c.degree}`, C.gray)}`)
  }

  // Typed neighborhoods around the two hubs: the project and the person.
  for (const hub of ["Chitta", "Nipurn"]) {
    const nb = await mem.graph.neighbors(hub)
    if (!nb || nb.neighbors.length === 0) continue
    console.log(`\n  ${paint(hub, C.bold, C.cyan)} ${paint("is connected to:", C.dim)}`)
    for (const e of nb.neighbors) {
      const arrow = paint(`──${e.relation}──▶`, C.yellow)
      // direction "out" ⇒ hub → neighbor; "in" ⇒ neighbor → hub
      const [l, r] = e.direction === "out" ? [hub, e.label] : [e.label, hub]
      console.log(`     ${paint(l, C.green)} ${arrow} ${paint(r, C.green)}`)
    }
  }
  console.log()
  console.log(rule())
  console.log(`  ${paint("aha:", C.bold, C.green)} session 2 never saw session 1 run — it only opened the file,`)
  console.log(`       and recalled the facts + reconstructed the graph. That's cross-session memory.`)
  console.log(rule())
  console.log()
}

// ── dispatch ────────────────────────────────────────────────────────────────────
const mode = process.argv[2] ?? "all"
if (mode === "session1") await runSession1()
else if (mode === "session2") await runSession2()
else {
  await runSession1()
  await runSession2()
}
