// Pooled LongMemEval, end to end: answer EVERY question (abstention included) with the same LLM,
// once from Chitta's top-k and once from the BM25+dense RRF baseline's top-k, judge both with
// LongMemEval's per-type rules, and report accuracy per question type. Same store, same reader,
// same judge, same per-record budget (one chunk per record) - the only difference is WHICH records
// reached the reader. The store must already exist (build it with `bench longmemeval --pooled`).

import { existsSync } from "node:fs"
import { buildEmbeddedContext } from "../../embedded/index"
import { serverPipeline } from "../../embedded/personal"
import { assertRerankerReady } from "../../embedded/reranker"
import { parseDate } from "../../embedded/retrieval/time-stage"
import { longMemEvalLoader } from "../datasets/longmemeval"
import type { BenchQuestion } from "../datasets/types"
import { buildBaselines, POOLED_ORG, POOLED_USER } from "./pooled"
import { judgePrediction, scoreQa } from "./qa"
import { answerFromRecords, breadth, searchHits, type ReaderModel } from "../../embedded/reader"
import { approxTokens, type BenchLlm, type RetrievedContext } from "./types"

export interface PooledQaMethod {
  method: string
  n: number
  correct: number
  accuracy: number
  byType: Record<string, { n: number; correct: number }>
  avgContextTokens: number
}

export interface PooledQaReport {
  k: number
  methods: PooledQaMethod[]
  /** Chitta's context beats the baseline's (strictly). */
  pass: boolean
}

export async function runPooledQa(o: {
  path: string
  store: string
  llm: BenchLlm
  k?: number
  rerank?: boolean
  concurrency?: number
  /** write `<prefix>chitta.jsonl` / `<prefix>rrf.jsonl` hypotheses (question_id, hypothesis) */
  hypsPrefix?: string
  log?: (m: string) => void
}): Promise<PooledQaReport> {
  const k = o.k ?? 10
  const log = o.log ?? (() => {})
  if (!existsSync(o.store)) throw new Error(`${o.store} not found - build it first with: bench longmemeval --pooled --path ... --store ${o.store}`)
  const questions: BenchQuestion[] = (await longMemEvalLoader.load({ path: o.path })).cases.flatMap((c) => c.questions)
  const pipeline = serverPipeline()
  const reranker = o.rerank === false ? undefined : pipeline.reranker
  if (reranker) await assertRerankerReady(reranker)
  const ctx = buildEmbeddedContext({ path: o.store, ...pipeline, reranker })
  ctx.ingestor.registerUser(POOLED_USER, POOLED_ORG, undefined, "admin")
  const base = await buildBaselines(ctx, POOLED_USER, POOLED_ORG)
  const chunkText = ctx.store.db.query("SELECT content FROM chunks WHERE point_id = ?")

  const contexts: Record<"chitta" | "bm25+dense-rrf", RetrievedContext[]> = { chitta: [], "bm25+dense-rrf": [] }
  const make = (question: BenchQuestion, ids: string[], parts: string[]): RetrievedContext => {
    const contextText = parts.filter(Boolean).join("\n\n---\n\n")
    return { question, rankedRecordIds: ids, contextText, contextTokens: approxTokens(contextText) }
  }
  // Retrieval is read-only, so questions can be searched concurrently - in LLM mode each search
  // waits on a model call (query rewriting), and overlapping those waits is most of the speed.
  const conc = Math.max(1, o.concurrency ?? 8)
  let next = 0
  let done = 0
  const worker = async () => {
    while (next < questions.length) {
      const i = next++
      const q = questions[i]
      const res = await ctx.searchWithGraph(q.question, POOLED_USER, POOLED_ORG, undefined, k, { now: parseDate(q.questionDate) ?? undefined })
      const ids: string[] = []
      const parts: string[] = []
      for (const r of res.searchResults) {
        const m = r.metadata as { recordId?: string; point_id?: string }
        if (!m.recordId || ids.includes(m.recordId)) continue
        ids.push(m.recordId)
        parts.push((m.point_id && (chunkText.get(m.point_id) as { content: string } | null)?.content) || r.content)
      }
      contexts.chitta[i] = make(q, ids, parts)
      const rrfIds = base.rrf(base.bm25(q.question), await base.dense(q.question)).slice(0, k)
      contexts["bm25+dense-rrf"][i] = make(q, rrfIds, await base.bestChunks(q.question, rrfIds))
      if (++done % 100 === 0) log(`contexts: ${done}/${questions.length}`)
    }
  }
  await Promise.all(Array.from({ length: conc }, worker))
  ctx.store.close()

  const methods: PooledQaMethod[] = []
  for (const method of ["chitta", "bm25+dense-rrf"] as const) {
    const byType: PooledQaMethod["byType"] = {}
    const hyps: string[] = []
    let done = 0
    const rows = await scoreQa(contexts[method], o.llm, {
      concurrency: 2 * conc, // answer + judge calls are pure waits
      onAnswer: (q, predicted, correct) => {
        const t = q.abstain ? "abstention" : (q.sourceType ?? q.category)
        const b = (byType[t] ??= { n: 0, correct: 0 })
        b.n++
        if (correct) b.correct++
        hyps.push(JSON.stringify({ question_id: q.id, hypothesis: predicted }))
        if (++done % 100 === 0) log(`${method}: answered ${done}/${questions.length}`)
      },
    })
    const all = rows.find((r) => r.category === "overall")!
    const toks = contexts[method].map((c) => c.contextTokens)
    methods.push({ method, n: all.n, correct: all.correct, accuracy: all.accuracy, byType, avgContextTokens: Math.round(toks.reduce((a, b) => a + b, 0) / (toks.length || 1)) })
    if (o.hypsPrefix) await Bun.write(`${o.hypsPrefix}${method === "chitta" ? "chitta" : "rrf"}.jsonl`, hyps.join("\n") + "\n")
  }
  const acc = (m: string) => methods.find((x) => x.method === m)!.accuracy
  return { k, methods, pass: acc("chitta") > acc("bm25+dense-rrf") }
}

/** The same comparison through Chitta's MEMORY READER (reader.ts): each question is routed once
 *  (kind + search rewrites), then read twice by the identical reader with the identical breadth -
 *  once over Chitta's sessions, once over the RRF baseline's - and both answers are judged by the
 *  per-type rules. Only WHICH sessions are read differs. */
export async function runPooledReaderQa(o: {
  path: string
  store: string
  judge: BenchLlm
  reader: ReaderModel
  rerank?: boolean
  concurrency?: number
  hypsPrefix?: string
  log?: (m: string) => void
}): Promise<PooledQaReport> {
  const log = o.log ?? (() => {})
  if (!existsSync(o.store)) throw new Error(`${o.store} not found - build it first with: bench longmemeval --pooled --path ... --store ${o.store}`)
  const questions: BenchQuestion[] = (await longMemEvalLoader.load({ path: o.path })).cases.flatMap((c) => c.questions)
  const pipeline = serverPipeline()
  const reranker = o.rerank === false ? undefined : pipeline.reranker
  if (reranker) await assertRerankerReady(reranker)
  const ctx = buildEmbeddedContext({ path: o.store, ...pipeline, reranker })
  ctx.ingestor.registerUser(POOLED_USER, POOLED_ORG, undefined, "admin")
  const base = await buildBaselines(ctx, POOLED_USER, POOLED_ORG)
  const deps = { store: ctx.store, embeddings: ctx.embeddings }
  const methods = ["chitta", "bm25+dense-rrf"] as const
  const out = methods.map((method) => ({ method, rows: new Array<{ q: BenchQuestion; answer: string; correct: boolean; chars: number }>(questions.length) }))
  let next = 0
  let done = 0
  const worker = async () => {
    while (next < questions.length) {
      const i = next++
      const q = questions[i]
      const route = (await o.reader.routeQuestion?.(q.question).catch(() => null)) ?? { kind: "single" as const, queries: [] }
      const k = breadth(route.kind)
      const res = await ctx.searchWithGraph(q.question, POOLED_USER, POOLED_ORG, undefined, k, { now: parseDate(q.questionDate) ?? undefined, expansions: route.queries })
      const chitta = searchHits(res) // Chitta's sessions + the chunks its search returned
      const rrfIds = base.rrf(base.bm25(q.question), await base.dense(q.question)).slice(0, k)
      for (const [m, ids, hits] of [[0, chitta.ids, chitta.hits], [1, rrfIds, undefined]] as const) {
        const r = await answerFromRecords(deps, q.question, ids, { model: o.reader, now: q.questionDate, kind: route.kind, hits }).catch(() => ({ answer: "", contextChars: 0 }))
        out[m].rows[i] = { q, answer: r.answer, correct: await judgePrediction(q, r.answer, o.judge), chars: r.contextChars }
      }
      if (++done % 50 === 0) log(`reader: ${done}/${questions.length} questions`)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 8) }, worker))
  ctx.store.close()

  const report: PooledQaMethod[] = []
  for (const { method, rows } of out) {
    const byType: PooledQaMethod["byType"] = {}
    for (const { q, correct } of rows) {
      const t = q.abstain ? "abstention" : (q.sourceType ?? q.category)
      const b = (byType[t] ??= { n: 0, correct: 0 })
      b.n++
      if (correct) b.correct++
    }
    const correct = rows.filter((r) => r.correct).length
    const avgChars = rows.reduce((a, r) => a + r.chars, 0) / (rows.length || 1)
    report.push({ method, n: rows.length, correct, accuracy: rows.length ? correct / rows.length : 0, byType, avgContextTokens: Math.round(avgChars / 4) })
    if (o.hypsPrefix)
      await Bun.write(`${o.hypsPrefix}${method === "chitta" ? "chitta" : "rrf"}.jsonl`, rows.map((r) => JSON.stringify({ question_id: r.q.id, hypothesis: r.answer })).join("\n") + "\n")
  }
  return { k: Number(process.env.CONTEXT_READER_K ?? 10), methods: report, pass: report[0].accuracy > report[1].accuracy }
}

export function renderPooledQa(r: PooledQaReport): string {
  const types = [...new Set(r.methods.flatMap((m) => Object.keys(m.byType)))].sort()
  const pct = (c: number, n: number) => (n ? `${((100 * c) / n).toFixed(1)}%` : "-")
  const lines = [`Pooled LongMemEval - end-to-end answer accuracy, k=${r.k} (one chunk per record)`, ""]
  lines.push(`${"type".padEnd(28)}${r.methods.map((m) => m.method.padStart(18)).join("")}`)
  for (const t of types) lines.push(`${t.padEnd(28)}${r.methods.map((m) => `${pct(m.byType[t]?.correct ?? 0, m.byType[t]?.n ?? 0)} (${m.byType[t]?.n ?? 0})`.padStart(18)).join("")}`)
  lines.push(`${"ALL".padEnd(28)}${r.methods.map((m) => `${pct(m.correct, m.n)} (${m.n})`.padStart(18)).join("")}`)
  lines.push(`${"avg context tokens".padEnd(28)}${r.methods.map((m) => String(m.avgContextTokens).padStart(18)).join("")}`)
  lines.push("", `QA ${r.pass ? "PASS" : "FAIL"}: chitta ${pct(r.methods[0].correct, r.methods[0].n)} vs bm25+dense-rrf ${pct(r.methods[1].correct, r.methods[1].n)}`)
  return lines.join("\n")
}
