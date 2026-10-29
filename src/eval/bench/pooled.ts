// Pooled LongMemEval (Tier A) - the harder, more realistic retrieval test. The standard loader
// gives each question its own 1-6 evidence sessions; here EVERY session in the file goes into ONE
// store (940 for longmemeval_oracle.json), so each question must find its sessions among all of
// them, like a real memory that has seen everything. Chitta runs next to three baselines that rank
// Chitta's OWN chunks with Chitta's OWN embeddings (BM25, dense, BM25+dense RRF), so any gap is
// ranking logic, not chunking or the embedding model. The gate: Chitta must not lose to plain RRF
// on all-gold@k (every gold session in the top k).
//
// The store is built with the server's pipeline (serverPipeline), reranker included and required
// to load, and retrieval must not write salience - both checked, so the number describes what
// ships and no question can bias the next.

import { existsSync } from "node:fs"
import { buildEmbeddedContext, type EmbeddedContext } from "../../embedded/index"
import { serverPipeline } from "../../embedded/personal"
import { assertRerankerReady } from "../../embedded/reranker"
import { decodeF32 } from "../../embedded/store/vector-blob"
import { parseDate } from "../../embedded/retrieval/time-stage"
import { longMemEvalLoader } from "../datasets/longmemeval"
import type { HistoryItem } from "../datasets/types"
import { ingestCase } from "./ingest"

export interface PooledQuestion {
  id: string
  /** LongMemEval question_type (single-session-user, multi-session, temporal-reasoning, ...). */
  type: string
  question: string
  gold: string[]
  /** When the question is asked (question_date) - "now" for its relative time ("a week ago"). */
  date?: string
}

export interface PooledData {
  sessions: HistoryItem[]
  questions: PooledQuestion[]
}

/** Every distinct session in the file + every answerable question (abstention questions have no
 *  gold sessions, so they can't be scored for retrieval). */
export async function loadPooled(path: string): Promise<PooledData> {
  const ds = await longMemEvalLoader.load({ path })
  const sessions = new Map<string, HistoryItem>()
  const questions: PooledQuestion[] = []
  for (const c of ds.cases) {
    for (const h of c.history) if (!sessions.has(h.id)) sessions.set(h.id, h)
    for (const q of c.questions)
      if (!q.abstain && q.evidenceIds.length)
        questions.push({ id: q.id, type: q.sourceType ?? q.category, question: q.question, gold: q.evidenceIds, date: q.questionDate })
  }
  return { sessions: [...sessions.values()], questions }
}

export interface Ranked {
  ranked: string[]
  ms: number
}

export interface MethodRow {
  method: string
  /** "ALL" or a question type. */
  type: string
  n: number
  recall5: number
  recallK: number
  /** share of questions with EVERY gold session in the top k - the pass rate. */
  allK: number
  anyK: number
  mrr: number
  p50ms: number
  p95ms: number
  /** average distinct records returned. */
  records: number
}

export const BASELINES = ["bm25", "dense", "bm25+dense-rrf"] as const

const STOP = new Set(
  "a an the and or of to in on at for with is are was were be been i you me my we our it this that what which who when where how did do does have has had can could would should will about from by as your their there".split(" "),
)
const tok = (s: string) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => !STOP.has(t))

/** BM25, dense and their RRF over the store's own chunks + embeddings, ranked at RECORD level
 *  (a record's score is its best chunk's). Everything in memory: ~80 MB at 53k chunks. */
export async function buildBaselines(ctx: EmbeddedContext, userId: string, orgId: string) {
  const acc = await ctx.graph.getAccessibleVirtualRecordIds({ userId, orgId })
  const rows = ctx.store.db.query("SELECT virtual_record_id AS vid, content, embedding FROM chunks").all() as Array<{ vid: string; content: string; embedding: Uint8Array | ArrayBuffer | string }>
  const N = rows.length
  const rec = rows.map((r) => acc[r.vid] ?? r.vid)
  const dim = N ? decodeF32(rows[0].embedding).length : 0
  const M = new Float32Array(N * dim)
  rows.forEach((r, i) => {
    const v = decodeF32(r.embedding)
    let n = 0
    for (let j = 0; j < dim; j++) n += v[j] * v[j]
    n = Math.sqrt(n) || 1
    for (let j = 0; j < dim; j++) M[i * dim + j] = v[j] / n
  })
  // BM25 (k1=1.2, b=0.75)
  const post = new Map<string, Array<[number, number]>>()
  const dl = new Float32Array(N)
  rows.forEach((r, i) => {
    const tf = new Map<string, number>()
    for (const t of tok(r.content)) tf.set(t, (tf.get(t) ?? 0) + 1)
    for (const c of tf.values()) dl[i] += c
    for (const [t, c] of tf) (post.get(t) ?? post.set(t, []).get(t)!).push([i, c])
  })
  const avgdl = N ? dl.reduce((a, b) => a + b, 0) / N : 1
  const byRecord = (score: Float32Array): string[] => {
    const best = new Map<string, number>()
    for (let i = 0; i < N; i++) if (score[i] !== 0 && (best.get(rec[i]) ?? -Infinity) < score[i]) best.set(rec[i], score[i])
    return [...best.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r)
  }
  const bm25 = (q: string): string[] => {
    const s = new Float32Array(N)
    for (const t of new Set(tok(q))) {
      const p = post.get(t)
      if (!p) continue
      const idf = Math.log(1 + (N - p.length + 0.5) / (p.length + 0.5))
      for (const [i, c] of p) s[i] += (idf * c * 2.2) / (c + 1.2 * (0.25 + 0.75 * (dl[i] / avgdl)))
    }
    return byRecord(s)
  }
  const emb = ctx.embeddings
  const dense = async (q: string): Promise<string[]> => {
    const qv = await (emb.embedQuery ? emb.embedQuery(q) : emb.embedDense(q))
    let n = 0
    for (const x of qv) n += x * x
    n = Math.sqrt(n) || 1
    const s = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      let d = 0
      const o = i * dim
      for (let j = 0; j < dim; j++) d += M[o + j] * qv[j]
      s[i] = d / n
    }
    return byRecord(s)
  }
  const rrf = (...lists: string[][]): string[] => {
    const sc = new Map<string, number>()
    for (const l of lists) l.slice(0, 100).forEach((r, i) => sc.set(r, (sc.get(r) ?? 0) + 1 / (60 + i + 1)))
    return [...sc.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r)
  }
  // For answering: each record's chunk most similar to the question (what a plain RAG pipeline
  // would hand the reader for that record).
  const chunksOf = new Map<string, number[]>()
  rec.forEach((r, i) => (chunksOf.get(r) ?? chunksOf.set(r, []).get(r)!).push(i))
  const bestChunks = async (q: string, records: string[]): Promise<string[]> => {
    const qv = await (emb.embedQuery ? emb.embedQuery(q) : emb.embedDense(q))
    return records.map((r) => {
      let best = -1
      let bestScore = -Infinity
      for (const i of chunksOf.get(r) ?? []) {
        let d = 0
        for (let j = 0; j < dim; j++) d += M[i * dim + j] * qv[j]
        if (d > bestScore) [best, bestScore] = [i, d]
      }
      return best >= 0 ? rows[best].content : ""
    })
  }
  return { chunks: N, bm25, dense, rrf, bestChunks }
}

/** Score each method per question type (+ "ALL"). */
export function scorePooled(questions: PooledQuestion[], results: Map<string, Map<string, Ranked>>, k: number): MethodRow[] {
  const types = ["ALL", ...[...new Set(questions.map((q) => q.type))].sort()]
  const pct = (xs: number[], p: number) => {
    const s = [...xs].sort((a, b) => a - b)
    return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0
  }
  const out: MethodRow[] = []
  for (const type of types)
    for (const [method, byQ] of results) {
      const qs = questions.filter((q) => (type === "ALL" || q.type === type) && byQ.has(q.id))
      if (!qs.length) continue
      let r5 = 0, rk = 0, all = 0, any = 0, mrr = 0, recs = 0
      const ms: number[] = []
      for (const q of qs) {
        const { ranked, ms: t } = byQ.get(q.id)!
        const top = ranked.slice(0, k)
        const hit = (n: number) => q.gold.filter((g) => ranked.slice(0, n).includes(g)).length
        r5 += hit(5) / q.gold.length
        rk += hit(k) / q.gold.length
        all += hit(k) === q.gold.length ? 1 : 0
        any += hit(k) > 0 ? 1 : 0
        const first = top.findIndex((r) => q.gold.includes(r))
        mrr += first >= 0 ? 1 / (first + 1) : 0
        recs += top.length
        ms.push(t)
      }
      const n = qs.length
      out.push({ method, type, n, recall5: r5 / n, recallK: rk / n, allK: all / n, anyK: any / n, mrr: mrr / n, p50ms: pct(ms, 0.5), p95ms: pct(ms, 0.95), records: recs / n })
    }
  return out
}

export interface PooledOptions {
  /** longmemeval JSON (oracle, _s or _m - every session in it is pooled). */
  path: string
  /** SQLite store to build (or reuse). */
  store: string
  /** query an existing store instead of ingesting (it must have been built by this command). */
  reuse?: boolean
  k?: number
  /** cross-encoder on (default, like the server) or off. */
  rerank?: boolean
  log?: (m: string) => void
}

export interface PooledReport {
  k: number
  sessions: number
  questions: number
  chunks: number
  ingestSeconds?: number
  rerank: boolean
  rows: MethodRow[]
  perQuestion: Array<{ id: string; method: string; ranked: string[]; ms: number }>
  gate: { chitta: number; rrf: number; pass: boolean }
}

/** Extract fact keys for every session, CONTEXT_POOLED_FACTS_CONCURRENCY (16) calls at once,
 *  resuming from / saving to `cachePath`, and attach them to the sessions. */
async function attachFacts(
  sessions: HistoryItem[],
  llm: { extractFacts(text: string, occurredAt?: number | string): Promise<string[]> },
  cachePath: string,
  log: (m: string) => void,
): Promise<void> {
  const cache: Record<string, string[]> = existsSync(cachePath) ? await Bun.file(cachePath).json() : {}
  const todo = sessions.filter((s) => !cache[s.id])
  const conc = Math.max(1, Number(process.env.CONTEXT_POOLED_FACTS_CONCURRENCY ?? 16))
  const t0 = performance.now()
  let next = 0
  let done = 0
  const worker = async () => {
    while (next < todo.length) {
      const s = todo[next++]
      cache[s.id] = await llm.extractFacts(s.text, s.timestamp).catch(() => [])
      if (++done % 50 === 0) {
        await Bun.write(cachePath, JSON.stringify(cache))
        log(`facts: ${done}/${todo.length} sessions  ${((performance.now() - t0) / 1000).toFixed(0)}s`)
      }
    }
  }
  await Promise.all(Array.from({ length: conc }, worker))
  await Bun.write(cachePath, JSON.stringify(cache))
  for (const s of sessions) s.facts = cache[s.id] ?? []
  const n = sessions.reduce((a, s) => a + (s.facts?.length ?? 0), 0)
  log(`facts: ${n} fact keys for ${sessions.length} sessions (${sessions.filter((s) => !s.facts?.length).length} with none)`)
}

export const POOLED_USER = "bench-user"
export const POOLED_ORG = "bench-org"

export async function runPooled(o: PooledOptions): Promise<PooledReport> {
  const k = o.k ?? 10
  const log = o.log ?? (() => {})
  const data = await loadPooled(o.path)
  const fresh = o.store === ":memory:" || !existsSync(o.store)
  if (!fresh && !o.reuse) throw new Error(`${o.store} already exists - pass --reuse to query it, or delete it to re-ingest`)

  const pipeline = serverPipeline()
  const reranker = o.rerank === false ? undefined : pipeline.reranker
  if (reranker) await assertRerankerReady(reranker)
  // LLM mode: fact keys are extracted UP FRONT, many calls at once, and cached next to the store
  // (a rebuild never pays twice), then passed in like a calling agent would pass them. Graph
  // extraction stays deterministic unless CONTEXT_POOLED_LLM_TRIPLES=1: the LLM triple extractor
  // is one more slow call per record, sequential at ingest (~hours for 940 sessions).
  const llmTriples = /^(1|true|on)$/i.test(process.env.CONTEXT_POOLED_LLM_TRIPLES ?? "")
  const ctx = buildEmbeddedContext({ path: o.store, ...pipeline, ...(pipeline.llm && !llmTriples ? { extractor: undefined } : {}), reranker })
  ctx.ingestor.registerUser(POOLED_USER, POOLED_ORG, undefined, "admin")

  let ingestSeconds: number | undefined
  if (fresh) {
    if (pipeline.llm) await attachFacts(data.sessions, pipeline.llm, `${o.store}.facts.json`, log)
    const t0 = performance.now()
    const n = data.sessions.length
    for (let i = 0; i < n; i += 50) {
      await ingestCase(ctx, { id: "pooled", history: data.sessions.slice(i, i + 50), questions: [] }, POOLED_USER, POOLED_ORG)
      log(`ingested ${Math.min(i + 50, n)}/${n} sessions  ${((performance.now() - t0) / 1000).toFixed(0)}s`)
    }
    ingestSeconds = (performance.now() - t0) / 1000
  }

  const results = new Map<string, Map<string, Ranked>>()
  const put = (method: string, id: string, r: Ranked) => (results.get(method) ?? results.set(method, new Map()).get(method)!).set(id, r)

  // Chitta, exactly as get_context calls it. Retrieval must be read-only: a write here would let
  // each question boost what it returned and bias every later one.
  const used = () => (ctx.store.db.query("SELECT COUNT(*) n FROM nodes WHERE coll = 'records' AND COALESCE(json_extract(data,'$.accessCount'), 0) > 0").get() as { n: number }).n
  const usedBefore = used()
  await ctx.searchWithGraph("warm up the embedder and reranker", POOLED_USER, POOLED_ORG, undefined, k)
  for (const [i, q] of data.questions.entries()) {
    const t0 = performance.now()
    const res = await ctx.searchWithGraph(q.question, POOLED_USER, POOLED_ORG, undefined, k, { now: parseDate(q.date) ?? undefined })
    const ms = performance.now() - t0
    const ranked: string[] = []
    for (const r of res.searchResults) {
      const id = (r.metadata as { recordId?: string }).recordId
      if (id && !ranked.includes(id)) ranked.push(id)
    }
    put("chitta", q.id, { ranked, ms })
    if ((i + 1) % 100 === 0) log(`chitta: ${i + 1}/${data.questions.length}`)
  }
  if (used() !== usedBefore) throw new Error("retrieval recorded accesses (salience writes): questions would contaminate each other")

  const base = await buildBaselines(ctx, POOLED_USER, POOLED_ORG)
  for (const q of data.questions) {
    let t0 = performance.now()
    const b = base.bm25(q.question)
    const bms = performance.now() - t0
    t0 = performance.now()
    const d = await base.dense(q.question)
    const dms = performance.now() - t0
    t0 = performance.now()
    const h = base.rrf(b, d)
    put("bm25", q.id, { ranked: b.slice(0, k), ms: bms })
    put("dense", q.id, { ranked: d.slice(0, k), ms: dms })
    put("bm25+dense-rrf", q.id, { ranked: h.slice(0, k), ms: performance.now() - t0 + bms + dms })
  }
  ctx.store.close()

  const rows = scorePooled(data.questions, results, k)
  const allOf = (m: string) => rows.find((r) => r.method === m && r.type === "ALL")?.allK ?? 0
  const perQuestion = [...results].flatMap(([method, byQ]) => [...byQ].map(([id, r]) => ({ id, method, ...r })))
  return {
    k,
    sessions: data.sessions.length,
    questions: data.questions.length,
    chunks: base.chunks,
    ingestSeconds,
    rerank: !!reranker,
    rows,
    perQuestion,
    gate: { chitta: allOf("chitta"), rrf: allOf("bm25+dense-rrf"), pass: allOf("chitta") >= allOf("bm25+dense-rrf") },
  }
}

export function renderPooled(r: PooledReport): string {
  const f = (x: number) => x.toFixed(3)
  const lines = [
    `Pooled LongMemEval - ${r.sessions} sessions (${r.chunks} chunks) in one store, ${r.questions} answerable questions, k=${r.k}, reranker ${r.rerank ? "on" : "off"}` +
      (r.ingestSeconds != null ? `, ingest ${r.ingestSeconds.toFixed(0)}s` : ""),
    "",
    `${"method".padEnd(16)}${"n".padStart(5)}${"R@5".padStart(7)}${`R@${r.k}`.padStart(7)}${`All@${r.k}`.padStart(8)}${`Any@${r.k}`.padStart(8)}${"MRR".padStart(7)}${"p50ms".padStart(8)}${"p95ms".padStart(8)}${"recs".padStart(6)}`,
  ]
  let type = ""
  for (const x of r.rows) {
    if (x.type !== type) lines.push(`-- ${(type = x.type)}`)
    lines.push(
      `${x.method.padEnd(16)}${String(x.n).padStart(5)}${f(x.recall5).padStart(7)}${f(x.recallK).padStart(7)}${f(x.allK).padStart(8)}${f(x.anyK).padStart(8)}${f(x.mrr).padStart(7)}` +
        `${x.p50ms.toFixed(1).padStart(8)}${x.p95ms.toFixed(1).padStart(8)}${x.records.toFixed(1).padStart(6)}`,
    )
  }
  lines.push("", `GATE ${r.gate.pass ? "PASS" : "FAIL"}: chitta all-gold@${r.k} ${f(r.gate.chitta)} vs bm25+dense-rrf ${f(r.gate.rrf)}`)
  return lines.join("\n")
}
