// LongMemEval in its OFFICIAL shape (longmemeval_s / _m): every question has its own history, so
// each gets its own fresh store - ingest its ~50 sessions, answer with Chitta's memory reader,
// judge with the per-type rules. Embedding dominates ingest (~1 s per session), so the work is
// sharded across processes: `--shard i/N` takes every N-th question, appends one JSON line per
// question to `out`, and resumes past questions already in it. `mergePerQuestion` then builds the
// per-type table from the shard files.

import { appendFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import { buildEmbeddedContext } from "../../embedded/index"
import { serverPipeline } from "../../embedded/personal"
import { assertRerankerReady } from "../../embedded/reranker"
import { answerQuestion, type ReaderModel } from "../../embedded/reader"
import { longMemEvalLoader } from "../datasets/longmemeval"
import { ingestCase } from "./ingest"
import { judgePrediction } from "./qa"
import type { BenchLlm } from "./types"

export interface PerQuestionRow {
  id: string
  type: string
  answer: string
  correct: boolean
  kind: string
  contextChars: number
  ingestMs: number
  answerMs: number
}

export async function runPerQuestionShard(o: {
  path: string
  shard: number
  shards: number
  out: string
  reader: ReaderModel
  judge: BenchLlm
  rerank?: boolean
  /** Keep each question's store as `<dir>/<question_id>.db` and reuse it on later runs, so a
   *  reader change doesn't re-embed every history. Unset: in-memory stores. */
  storeDir?: string
  /** Build (and save) the stores only - no model calls. Reading can then run later, against a
   *  shared rate limit, without the CPU-heavy ingest in the way. Needs storeDir. */
  ingestOnly?: boolean
  log?: (m: string) => void
}): Promise<number> {
  const log = o.log ?? (() => {})
  const done = new Set<string>()
  if (existsSync(o.out)) for (const l of (await Bun.file(o.out).text()).split("\n")) if (l) done.add((JSON.parse(l) as PerQuestionRow).id)
  const cases = (await longMemEvalLoader.load({ path: o.path })).cases.filter((_, i) => i % o.shards === o.shard)
  const pipeline = serverPipeline()
  const reranker = o.rerank === false ? undefined : pipeline.reranker
  if (reranker) await assertRerankerReady(reranker)
  if (o.storeDir) mkdirSync(o.storeDir, { recursive: true })
  let n = 0
  for (const c of cases) {
    const q = c.questions[0]
    if (!q || done.has(q.id)) continue
    // A fresh, isolated memory per question - its own history only. Deterministic ingest (no LLM),
    // the server's embedder; the LLM is used for routing + reading.
    const file = o.storeDir ? `${o.storeDir}/${q.id}.db` : ":memory:"
    const built = file !== ":memory:" && existsSync(`${file}.ok`) // marker written after a complete ingest
    if (file !== ":memory:" && !built) for (const s of ["", "-wal", "-shm"]) if (existsSync(file + s)) unlinkSync(file + s) // half-built
    const ctx = buildEmbeddedContext({ path: file, embeddings: pipeline.embeddings, reranker })
    ctx.ingestor.registerUser("u", "o", undefined, "admin")
    const t0 = performance.now()
    if (!built) {
      await ingestCase(ctx, c, "u", "o")
      if (file !== ":memory:") writeFileSync(`${file}.ok`, "")
    }
    const t1 = performance.now()
    if (o.ingestOnly && o.storeDir) {
      ctx.store.close()
      if (++n % 5 === 0) log(`shard ${o.shard}/${o.shards}: ${n} stores ready`)
      continue
    }
    const r = await answerQuestion({ store: ctx.store, embeddings: ctx.embeddings, search: ctx.searchWithGraph }, q.question, "u", "o", {
      model: o.reader,
      now: q.questionDate,
    }).catch((e) => ({ answer: "", kind: "error", contextChars: 0, notes: String(e), recordIds: [] }))
    // An empty answer or a missing verdict means a model call failed - not a wrong answer. Write
    // no row, so the next (resumed) run answers it again instead of the score counting the outage.
    const correct = r.answer ? await judgePrediction(q, r.answer, o.judge, { rethrow: true }).catch(() => null) : null
    ctx.store.close()
    if (correct === null) {
      log(`shard ${o.shard}/${o.shards}: ${q.id} not scored (${r.answer ? "judge call failed" : "no answer"}) - left for a resumed run`)
      continue
    }
    const row: PerQuestionRow = {
      id: q.id,
      type: q.abstain ? "abstention" : (q.sourceType ?? q.category),
      answer: r.answer,
      correct,
      kind: r.kind,
      contextChars: r.contextChars,
      ingestMs: Math.round(t1 - t0),
      answerMs: Math.round(performance.now() - t1),
    }
    appendFileSync(o.out, `${JSON.stringify(row)}\n`)
    if (++n % 5 === 0) log(`shard ${o.shard}/${o.shards}: ${done.size + n}/${cases.length} done`)
  }
  return n
}

export function mergePerQuestion(rows: PerQuestionRow[]): string {
  const by = new Map<string, { n: number; c: number }>()
  for (const r of rows) {
    const b = by.get(r.type) ?? by.set(r.type, { n: 0, c: 0 }).get(r.type)!
    b.n++
    if (r.correct) b.c++
  }
  const pct = (c: number, n: number) => `${((100 * c) / (n || 1)).toFixed(1)}%`
  const all = rows.filter((r) => r.correct).length
  const avg = (f: (r: PerQuestionRow) => number) => Math.round(rows.reduce((a, r) => a + f(r), 0) / (rows.length || 1))
  return [
    `LongMemEval per-question answer accuracy - ${rows.length} questions`,
    ...[...by].sort().map(([t, b]) => `${t.padEnd(28)}${pct(b.c, b.n).padStart(8)}  (${b.c}/${b.n})`),
    `${"ALL".padEnd(28)}${pct(all, rows.length).padStart(8)}  (${all}/${rows.length})`,
    `avg context ${avg((r) => r.contextChars / 4)} tokens, ingest ${avg((r) => r.ingestMs)} ms, answer ${avg((r) => r.answerMs)} ms`,
  ].join("\n")
}
