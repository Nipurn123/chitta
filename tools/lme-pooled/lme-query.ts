// Query phase for the pooled LongMemEval store. Each mode runs on its own copy of the DB
// (Chitta bumps access counts on every retrieval, so runs must not contaminate each other).
// usage: bun run lme-query.ts <db-copy> <baselines|chitta|chitta-ppr> <out.jsonl>
import { buildEmbeddedContext } from "../../src/embedded/index"
import { decodeF32 } from "../../src/embedded/store/vector-blob"
import { appendFileSync, existsSync, unlinkSync } from "node:fs"

const [db, mode, out] = [process.argv[2], process.argv[3], process.argv[4]]
if (existsSync(out)) unlinkSync(out)
process.env.CONTEXT_GRAPH_PPR = mode === "chitta-ppr" ? "1" : "0"
const K = 10
const questions = (await Bun.file(`${import.meta.dir}/lme-questions.json`).json()) as Array<{ id: string; type: string; abs: boolean; question: string; gold: string[] }>
const ctx = buildEmbeddedContext({ path: db })
const emb: any = ctx.embeddings
const embedQ = async (q: string): Promise<number[]> => (emb.embedQuery ? emb.embedQuery(q) : emb.embedDense(q))
const write = (o: object) => appendFileSync(out, JSON.stringify(o) + "\n")

if (mode === "chitta" || mode === "chitta-ppr") {
  await ctx.searchWithGraph("warm up the embedder", "u", "o", undefined, K)
  let i = 0
  for (const q of questions) {
    const t0 = performance.now()
    const res = await ctx.searchWithGraph(q.question, "u", "o", undefined, K)
    const ms = performance.now() - t0
    const ranked: string[] = []
    for (const r of res.searchResults) {
      const id = (r.metadata as any).recordId
      if (id && !ranked.includes(id)) ranked.push(id)
    }
    const tokens = Math.round(res.searchResults.map((r) => r.content).join("\n\n").length / 4)
    write({ id: q.id, method: mode, ranked, ms, tokens })
    if (++i % 100 === 0) console.log(`${mode}: ${i}/${questions.length}`)
  }
} else {
  // Baselines over Chitta's OWN chunks + embeddings, so chunking and the embedding model are
  // identical - the only difference is the ranking logic.
  const st: any = ctx.store
  const rows = st.db.query("SELECT virtual_record_id AS vid, content, embedding FROM chunks").all() as Array<{ vid: string; content: string; embedding: any }>
  const N = rows.length
  const dim = decodeF32(rows[0].embedding).length
  const M = new Float32Array(N * dim)
  rows.forEach((r, i) => {
    const v = decodeF32(r.embedding)
    let n = 0
    for (let j = 0; j < dim; j++) n += v[j] * v[j]
    n = Math.sqrt(n) || 1
    for (let j = 0; j < dim; j++) M[i * dim + j] = v[j] / n
  })
  // BM25 (k1=1.2, b=0.75) over the same chunks
  const STOP = new Set("a an the and or of to in on at for with is are was were be been i you me my we our it this that what which who when where how did do does have has had can could would should will about from by as your their there".split(" "))
  const tok = (s: string) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => !STOP.has(t))
  const post = new Map<string, Array<[number, number]>>()
  const dl = new Float32Array(N)
  rows.forEach((r, i) => {
    const tf = new Map<string, number>()
    for (const t of tok(r.content)) tf.set(t, (tf.get(t) ?? 0) + 1)
    dl[i] = [...tf.values()].reduce((a, b) => a + b, 0)
    for (const [t, c] of tf) (post.get(t) ?? post.set(t, []).get(t)!).push([i, c])
  })
  const avgdl = dl.reduce((a, b) => a + b, 0) / N
  const recordRank = (chunkScore: Float32Array) => {
    const best = new Map<string, number>()
    for (let i = 0; i < N; i++) if (chunkScore[i] > 0 || chunkScore[i] < 0) { const v = rows[i].vid; if ((best.get(v) ?? -Infinity) < chunkScore[i]) best.set(v, chunkScore[i]) }
    return [...best.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v)
  }
  const bm25 = (q: string) => {
    const s = new Float32Array(N)
    for (const t of new Set(tok(q))) {
      const p = post.get(t); if (!p) continue
      const idf = Math.log(1 + (N - p.length + 0.5) / (p.length + 0.5))
      for (const [i, c] of p) s[i] += (idf * c * 2.2) / (c + 1.2 * (0.25 + 0.75 * (dl[i] / avgdl)))
    }
    return recordRank(s)
  }
  const dense = async (q: string) => {
    const qv = await embedQ(q)
    let n = 0
    for (const x of qv) n += x * x
    n = Math.sqrt(n) || 1
    const s = new Float32Array(N)
    for (let i = 0; i < N; i++) { let d = 0; const o = i * dim; for (let j = 0; j < dim; j++) d += M[o + j] * qv[j]; s[i] = d / n }
    return recordRank(s)
  }
  const rrf = (...lists: string[][]) => {
    const sc = new Map<string, number>()
    for (const l of lists) l.slice(0, 100).forEach((v, i) => sc.set(v, (sc.get(v) ?? 0) + 1 / (60 + i + 1)))
    return [...sc.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v)
  }
  console.log(`baselines over ${N} chunks, dim ${dim}`)
  await embedQ("warm up")
  for (const q of questions) {
    let t0 = performance.now(); const b = bm25(q.question); const bms = performance.now() - t0
    t0 = performance.now(); const d = await dense(q.question); const dms = performance.now() - t0
    t0 = performance.now(); const h = rrf(b, d); const hms = performance.now() - t0 + bms + dms
    write({ id: q.id, method: "bm25", ranked: b.slice(0, K), ms: bms })
    write({ id: q.id, method: "dense", ranked: d.slice(0, K), ms: dms })
    write({ id: q.id, method: "bm25+dense-rrf", ranked: h.slice(0, K), ms: hms })
  }
}
console.log(`${mode} done`)
