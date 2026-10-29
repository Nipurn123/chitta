// Ablation runner for Chitta's searchWithGraph on the pooled LongMemEval store. Pipeline knobs
// come from CONTEXT_* env as in production; on top of that:
//   LABEL   method name written to the jsonl
//   RERANK  1 → pass the CrossEncoderReranker (what personal.ts / the MCP server does by default)
//   FETCH   chunks to request (default 10); output is the first 10 DISTINCT records among them
// usage: LABEL=x [RERANK=1] [FETCH=40] [CONTEXT_*=...] bun run lme-ablate.ts <db-copy> <out.jsonl>
import { buildEmbeddedContext } from "../../src/embedded/index"
import { CrossEncoderReranker } from "../../src/embedded/reranker"
import { appendFileSync, existsSync, unlinkSync } from "node:fs"

const [db, out] = [process.argv[2], process.argv[3]]
if (existsSync(out)) unlinkSync(out)
const label = process.env.LABEL ?? "chitta"
const fetch = Number(process.env.FETCH ?? 10)
const K = 10
const questions = (await Bun.file(`${import.meta.dir}/lme-questions.json`).json()) as Array<{ id: string; question: string }>
const reranker = process.env.RERANK === "1" ? new CrossEncoderReranker() : undefined
const ctx = buildEmbeddedContext({ path: db, reranker })
await ctx.searchWithGraph("warm up the embedder", "u", "o", undefined, fetch)
let i = 0
for (const q of questions) {
  const t0 = performance.now()
  const res = await ctx.searchWithGraph(q.question, "u", "o", undefined, fetch)
  const ms = performance.now() - t0
  const ranked: string[] = []
  for (const r of res.searchResults) {
    const id = (r.metadata as any).recordId
    if (id && !ranked.includes(id)) ranked.push(id)
    if (ranked.length >= K) break
  }
  const tokens = Math.round(res.searchResults.map((r) => r.content).join("\n\n").length / 4)
  appendFileSync(out, JSON.stringify({ id: q.id, method: label, ranked, ms, tokens }) + "\n")
  if (++i % 100 === 0) console.log(`${label}: ${i}/${questions.length}`)
}
console.log(`${label} done`)
