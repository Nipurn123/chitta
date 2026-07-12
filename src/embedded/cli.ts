// Standalone context CLI - the complete system in one runnable program.
// Persists to a real .db file, so ingest and query work across invocations.
//
//   bun run cli.ts user-add alice --org org1
//   bun run cli.ts ingest --id doc1 --org org1 --name "Notes" --share-user alice --text "hello world"
//   bun run cli.ts query "hello" --user alice --org org1
//
// Compile to a single binary:
//   bun build cli.ts --compile --outfile ctx

import { buildEmbeddedContext } from "./index"
import { rekeyDatabase } from "./store/rekey"

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback
}
function has(flag: string): boolean {
  return process.argv.includes(flag)
}

// Resolve a benchmark dataset by name. The synthetic set is built-in (offline); the real
// datasets are loaded from a downloaded JSON via `--path`. The loaders are imported through a
// VARIABLE specifier so the CLI type-checks whether or not the optional loader files are present.
async function loadBenchDataset(name: string, opts: { path?: string; limit?: number }) {
  if (name === "synthetic") return (await import("../eval/datasets/synthetic")).syntheticDataset
  const spec = name === "longmemeval" ? "../eval/datasets/longmemeval" : name === "locomo" ? "../eval/datasets/locomo" : null
  if (!spec) throw new Error(`unknown dataset '${name}' (use: synthetic | longmemeval | locomo)`)
  const mod = await import(spec)
  const loader = name === "longmemeval" ? mod.longMemEvalLoader : mod.locomoLoader
  return loader.load(opts)
}

async function main() {
  const cmd = process.argv[2]
  const dbPath = arg("--db", process.env.CONTEXT_DB ?? "context.db")!

  // rekey runs BEFORE opening the store (it manages its own old/new-key handles).
  if (cmd === "rekey") {
    const oldKey = process.env.CONTEXT_DB_KEY ?? ""
    const newKey = arg("--new-key") ?? ""
    if (oldKey === newKey) {
      console.log("nothing to do: --new-key equals the current CONTEXT_DB_KEY. Set CONTEXT_DB_KEY to the OLD key and pass the NEW key via --new-key (use '' to decrypt).")
      return
    }
    const r = await rekeyDatabase(dbPath, oldKey, newKey)
    console.log(
      `re-encrypted ${dbPath}: ${r.records} node(s), ${r.edges} edge(s), ${r.chunks} chunk(s), ${r.memories} memor(ies), ${r.audit} audit row(s).\n` +
        `backup of the original: ${r.backup}\n` +
        `→ now set CONTEXT_DB_KEY="${newKey ? "<new key>" : ""}" (${newKey ? "encrypted" : "plaintext"}) for future runs, and delete the backup once verified.`,
    )
    return
  }

  // doctor: show the EFFECTIVE config + health the MCP server would run with (uses the
  // real personal store path + identity, not the generic CLI db), so users can verify
  // setup at a glance instead of guessing env vars.
  if (cmd === "doctor") {
    const { personalContext, personalContextPath, identity } = await import("./personal")
    const id = identity()
    const ctx = personalContext()
    const s = ctx.store
    const enc = !!process.env.CONTEXT_DB_KEY
    const audit = /^(1|true|on)$/i.test(process.env.CHITTA_AUDIT ?? "")
    const rerank = !/^(0|false|off)$/i.test(process.env.CONTEXT_RERANK ?? "")
    const count = (sql: string) => (s.db.query(sql).get() as { c: number }).c
    const ok = (b: boolean) => (b ? "\x1b[32m✓\x1b[0m" : "\x1b[2m–\x1b[0m")
    const lines = [
      "Chitta — configuration & health\n",
      `  identity     user=${id.userId}  org=${id.orgId}  role=${id.role}${id.groups.length ? `  groups=${id.groups.join(",")}` : ""}`,
      `  storage      ${personalContextPath()}`,
      `  ${ok(enc)} encryption  ${enc ? "ON (libSQL AES-256 at rest)" : "off — enable with: chitta install --db-key <key>"}`,
      `  ${ok(s.annEnabled)} vector ANN  ${s.annEnabled ? "on (index active)" : "brute-force cosine (no ANN index loaded)"}`,
      `  ${ok(true)} embeddings  ${(process.env.CONTEXT_EMBEDDINGS ?? "auto").toLowerCase()}${process.env.CONTEXT_EMBED_MODEL ? ` (${process.env.CONTEXT_EMBED_MODEL})` : ""}`,
      `  ${ok(rerank)} reranker    ${rerank ? "on (cross-encoder, lazy)" : "off"}`,
      `  ${ok(audit)} audit log   ${audit ? "ON (append-only, tamper-evident)" : "off — enable with: CHITTA_AUDIT=1"}`,
      `  ${ok(!!process.env.CONTEXT_MEMORY_TTL_DAYS)} memory TTL  ${process.env.CONTEXT_MEMORY_TTL_DAYS ? `${process.env.CONTEXT_MEMORY_TTL_DAYS} days` : "none (memories don't auto-expire)"}`,
      `  ${ok(!!process.env.CONTEXT_LLM_URL)} LLM extract ${process.env.CONTEXT_LLM_URL ? `${process.env.CONTEXT_LLM_MODEL || "default"} @ ${process.env.CONTEXT_LLM_URL}` : "off (caller-supplied typed triples)"}`,
      "",
      `  contents     ${count("SELECT count(*) c FROM nodes WHERE coll='records'")} records · ${count("SELECT count(*) c FROM chunks")} chunks · ${count("SELECT count(*) c FROM nodes WHERE coll='entities'")} entities`,
    ]
    const m = s.memories.counts()
    lines.push(`  memory       ${m.current} current · ${m.forgotten} forgotten · ${m.total} versions`)
    if (audit) {
      const v = s.audit.verify()
      lines.push(`  audit chain  ${v.ok ? `intact (${v.entries} entries)` : `\x1b[31mBROKEN at id ${v.brokenAt}\x1b[0m`}`)
    }
    // actionable warnings
    if (enc) {
      try {
        (await import("node:module")).createRequire(import.meta.url)("libsql")
      } catch {
        lines.push(`\n  ⚠ CONTEXT_DB_KEY is set but the \`libsql\` package isn't installed — run: bun add libsql`)
      }
    }
    console.log(lines.join("\n"))
    s.close()
    return
  }

  // sleep: sleep-time consolidation over the REAL personal store (same DB the MCP server
  // serves) - dedupe entities, retire expired memories, re-weight importance by corroboration.
  if (cmd === "sleep") {
    const { personalContext } = await import("./personal")
    const ctx = personalContext()
    const r = ctx.sleep()
    console.log(
      `sleep-time consolidation: ${r.entitiesMerged} entit(ies) merged · ${r.memoriesExpired} memor(ies) expired · ${r.recordsReweighted} record(s) re-weighted`,
    )
    ctx.store.close()
    return
  }

  // graph: export the accessible knowledge graph to ONE self-contained, interactive HTML file —
  // Chitta's shareable "here's what your agent remembers" artifact (open it in any browser).
  if (cmd === "graph") {
    const { personalContext, identity } = await import("./personal")
    const { renderGraphHtml } = await import("./graph-html")
    const id = identity()
    const ctx = personalContext()
    const accessible = await ctx.graph.getAccessibleVirtualRecordIds({ userId: id.userId, orgId: id.orgId })
    const recordIds = [...new Set(Object.values(accessible))] as string[]
    const g = ctx.graph.getKnowledgeGraph(recordIds)
    const out = arg("--out", "chitta-graph.html")!
    await Bun.write(out, renderGraphHtml(g, { title: arg("--title") ?? "What Chitta remembers" }))
    console.log(`✓ ${g.entities.length} concepts · ${g.relations.length} relationships → ${out}`)
    if (has("--open")) {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open"
      try { Bun.spawn([opener, out]) } catch { /* opening is best-effort */ }
    }
    ctx.store.close()
    return
  }

  // bench: run the memory benchmark framework (Tier A retrieval, + Tier B end-to-end QA when
  // an LLM is configured). Builds its own per-case contexts, so it needs no shared store.
  if (cmd === "bench") {
    const { runBenchmark } = await import("../eval/bench/run")
    const { renderScorecard, scorecardMarkdown, scorecardJson } = await import("../eval/bench/scorecard")
    const { scoreQa } = await import("../eval/bench/qa")
    const { httpBenchLlmFromEnv } = await import("../eval/bench/llm")
    const name = process.argv[3] && !process.argv[3].startsWith("-") ? process.argv[3] : "synthetic"
    const tier = arg("--tier", "a") as "a" | "b" | "both"
    const k = Number(arg("--k", "10"))
    const limit = arg("--limit") ? Number(arg("--limit")) : undefined
    const dataset = await loadBenchDataset(name, { path: arg("--path"), limit })
    const llm = tier !== "a" ? httpBenchLlmFromEnv(arg("--answer-model"), arg("--judge-model")) : null
    if (tier !== "a" && !llm) console.log("(no CONTEXT_LLM_URL set → Tier B skipped; running Tier A only)\n")
    const model = process.env.CONTEXT_LLM_MODEL ?? "default"
    const card = await runBenchmark(
      dataset,
      {
        dataset: name,
        tier: llm ? tier : "a",
        k,
        limitCases: limit,
        maxQuestions: arg("--max-q") ? Number(arg("--max-q")) : undefined,
        embedder: (process.env.CONTEXT_EMBEDDINGS ?? "auto").toLowerCase(),
        rerank: has("--rerank"),
        answerModel: llm ? arg("--answer-model") ?? model : undefined,
        judgeModel: llm ? arg("--judge-model") ?? model : undefined,
      },
      { scoreQa, llm: llm ?? undefined },
    )
    console.log(has("--json") ? scorecardJson(card) : renderScorecard(card))
    const report = arg("--report")
    if (report) {
      await Bun.write(report, scorecardMarkdown(card))
      console.log(`\nreport written to ${report}`)
    }
    return
  }

  const ctx = buildEmbeddedContext({ path: dbPath })

  switch (cmd) {
    case "audit": {
      if (has("--verify")) {
        const v = ctx.store.audit.verify()
        console.log(v.ok ? `audit chain intact (${v.entries} entries, tamper-evident)` : `AUDIT TAMPERING DETECTED at id ${v.brokenAt}: ${v.reason}`)
      } else {
        const rows = ctx.store.audit.tail(Number(arg("--tail", "20")))
        if (rows.length === 0) console.log("(no audit entries - set CHITTA_AUDIT=1 to enable logging)")
        for (const r of rows.reverse()) {
          const when = new Date(r.ts).toISOString()
          console.log(`${when}  ${r.actor}@${r.org}  ${r.action}  ${r.ok ? "ok" : "DENIED/ERR"}  ${r.target}`)
        }
      }
      break
    }
    case "user-add": {
      const userId = process.argv[3]
      const org = arg("--org", "org1")!
      ctx.ingestor.registerUser(userId, org, arg("--email"))
      console.log(`user '${userId}' added to org '${org}'`)
      break
    }
    case "group-add": {
      ctx.ingestor.registerGroup(process.argv[3])
      console.log(`group '${process.argv[3]}' added`)
      break
    }
    case "member-add": {
      ctx.ingestor.addMembership(process.argv[3], arg("--group")!)
      console.log(`'${process.argv[3]}' added to group '${arg("--group")}'`)
      break
    }
    case "ingest": {
      const out = await ctx.ingestor.ingest({
        recordId: arg("--id") ?? `rec-${Date.now().toString(36)}`,
        orgId: arg("--org", "org1")!,
        recordName: arg("--name", "Untitled")!,
        text: arg("--text") ?? (arg("--file") ? await Bun.file(arg("--file")!).text() : ""),
        permittedPrincipals: [arg("--share-user"), arg("--share-group")].filter(Boolean) as string[],
        shareWithOrg: has("--share-org") ? arg("--org", "org1") : undefined,
      })
      console.log(`ingested '${out.recordId}' (${out.chunks} chunks)`)
      break
    }
    case "query": {
      const res = await ctx.retrieval.searchWithFilters({
        queries: [process.argv[3]],
        userId: arg("--user")!,
        orgId: arg("--org", "org1")!,
        limit: Number(arg("--limit", "5")),
      })
      console.log(`status: ${res.status}`)
      for (const r of res.searchResults) {
        console.log(`  • [${r.metadata.recordName}] ${r.content.slice(0, 80)}`)
      }
      if (res.searchResults.length === 0) console.log("  (no accessible context)")
      break
    }
    case "rebuild-graph": {
      const res = await ctx.rebuildGraph()
      console.log(`rebuilt knowledge graph: ${res.records} records → ${res.entities} concept-mentions`)
      break
    }
    case "reindex-vectors": {
      const n = await ctx.reindex()
      console.log(`re-embedded ${n} chunks and rebuilt the vector index`)
      break
    }
    default:
      console.log("commands: doctor | sleep | graph [--out f] [--open] | bench [synthetic|longmemeval|locomo] | user-add | group-add | member-add | ingest | query | rebuild-graph | reindex-vectors | audit [--verify|--tail N] | rekey --new-key <k>")
  }
  ctx.store.close()
}

main()
