// Micro-bench: exact brute-force vs Matryoshka two-stage (float32 / int8) dense search.
// Synthetic corpus with the deterministic hash embedder (offline, reproducible), bare
// chunks table (no FTS / no ANN index) so the numbers isolate the scan paths themselves.
//
//   bun tools/bench-vec.ts                 # 1K/5K/10K/50K/100K (+500K if projected < ~2 min)
//   bun tools/bench-vec.ts --sizes 10000,100000 --queries 20
//
// Reports per corpus size: cold latency (first query - includes the cache build), warm
// median/p95 latency, and recall@10 vs the exact scan. The fingerprint row shows the
// per-query coherence check (COUNT + MAX(rowid)) the MRL path pays.

import { Database } from "bun:sqlite"
import { SqliteVecService } from "../src/embedded/sqlite-vec-service"
import type { SqliteStore } from "../src/embedded/sqlite-store"
import { LocalHashEmbeddings } from "../src/embedded/local-embeddings"
import { encodeF32 } from "../src/embedded/store/vector-blob"

// ── deterministic corpus ─────────────────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const VOCAB = Array.from({ length: 4000 }, (_, i) => `tok${i}x`)

function docText(rnd: () => number): string {
  const words: string[] = []
  for (let w = 0; w < 12; w++) words.push(VOCAB[Math.floor(rnd() * VOCAB.length)])
  return words.join(" ")
}

// A query shares over half its tokens with one target doc - real similarity structure,
// so recall@10 measures ranking fidelity, not noise among near-orthogonal vectors.
function queryText(doc: string, rnd: () => number): string {
  const words = doc.split(" ")
  const picked: string[] = []
  for (let w = 0; w < 6; w++) picked.push(words[Math.floor(rnd() * words.length)])
  picked.push(VOCAB[Math.floor(rnd() * VOCAB.length)])
  return picked.join(" ")
}

// ── bare store stub (chunks table only - the service touches db/annEnabled/knnSearch) ──
function makeStore(): { db: Database; store: SqliteStore } {
  const db = new Database(":memory:")
  db.exec(`
    CREATE TABLE chunks (
      point_id TEXT PRIMARY KEY,
      virtual_record_id TEXT,
      org_id TEXT,
      content TEXT,
      embedding TEXT
    );
    CREATE INDEX idx_chunks_org ON chunks(org_id);
    CREATE INDEX idx_chunks_vid ON chunks(virtual_record_id);
  `)
  const store = { db, annEnabled: false, knnSearch: () => [] } as unknown as SqliteStore
  return { db, store }
}

const emb = new LocalHashEmbeddings()

async function buildCorpus(db: Database, n: number, rnd: () => number): Promise<string[]> {
  const ins = db.query("INSERT INTO chunks (point_id, virtual_record_id, org_id, content, embedding) VALUES (?, ?, ?, ?, ?)")
  const docs: string[] = []
  db.exec("BEGIN")
  for (let i = 0; i < n; i++) {
    const text = docText(rnd)
    docs.push(text)
    ins.run(`p${i}`, `v${i}`, "o", text, encodeF32(await emb.embedDense(text)))
    if (i % 25_000 === 24_999) {
      db.exec("COMMIT")
      db.exec("BEGIN")
    }
  }
  db.exec("COMMIT")
  return docs
}

// ── measurement ──────────────────────────────────────────────────────────────
async function search(svc: SqliteVecService, vec: number[], limit: number): Promise<string[]> {
  const [res] = await svc.queryNearestPoints({
    collectionName: "bench",
    requests: [{ prefetch: [{ query: vec, using: "dense" }], limit, filter: { must: { orgId: "o" } } }],
  })
  return res.points.map((pt) => String(pt.id))
}

function pct(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

function recall(got: string[], truth: string[]): number {
  const t = new Set(truth)
  return got.filter((id) => t.has(id)).length / Math.max(1, truth.length)
}

// exact = the pre-existing brute-force scan (ground truth). mrl / mrl-int8 = the shipped
// configuration (recall-calibrated prefix). mrl-p64* = the prefix PINNED at 64 dims
// (CONTEXT_MRL_CALIBRATE=0) - shows what raw Matryoshka truncation does on an embedder
// with a flat spectrum (the hash embedder spreads signal uniformly, so a fixed prefix
// loses recall; an MRL-trained model keeps it - that is exactly why calibration exists).
const MODES = [
  { name: "exact", env: { CONTEXT_MRL_DIMS: "0", CONTEXT_VEC_INT8: "", CONTEXT_MRL_CALIBRATE: "" } },
  { name: "mrl", env: { CONTEXT_MRL_DIMS: "", CONTEXT_VEC_INT8: "", CONTEXT_MRL_CALIBRATE: "" } },
  { name: "mrl-int8", env: { CONTEXT_MRL_DIMS: "", CONTEXT_VEC_INT8: "1", CONTEXT_MRL_CALIBRATE: "" } },
  { name: "mrl-p64", env: { CONTEXT_MRL_DIMS: "", CONTEXT_VEC_INT8: "", CONTEXT_MRL_CALIBRATE: "0" } },
  { name: "mrl-p64-int8", env: { CONTEXT_MRL_DIMS: "", CONTEXT_VEC_INT8: "1", CONTEXT_MRL_CALIBRATE: "0" } },
] as const

function setModeEnv(env: Record<string, string>): void {
  for (const [k, v] of Object.entries(env)) {
    if (v === "") delete process.env[k]
    else process.env[k] = v
  }
}

interface Row {
  size: number
  mode: string
  dims: string
  cold: number
  p50: number
  p95: number
  rec: number
  path: string
}

async function benchSize(size: number, queries: number, rows: Row[]): Promise<number> {
  const t0 = performance.now()
  const rnd = mulberry32(42)
  const { db, store } = makeStore()
  const docs = await buildCorpus(db, size, rnd)
  const svc = new SqliteVecService(store)

  // Query vectors, derived from random docs (seeded - identical across modes/runs).
  const qrnd = mulberry32(1337)
  const qvecs: number[][] = []
  for (let i = 0; i < queries; i++) {
    const doc = docs[Math.floor(qrnd() * docs.length)]
    qvecs.push(await emb.embedQuery(queryText(doc, qrnd)))
  }

  // The two coherence probes the MRL path pays: MAX(rowid) every query (O(log N)),
  // COUNT(*) only when MAX moved / every 32nd query (O(N) index scan).
  const fpT = performance.now()
  db.query("SELECT COALESCE(MAX(rowid), 0) AS m FROM chunks").get()
  const maxMs = performance.now() - fpT
  const cntT = performance.now()
  db.query("SELECT COUNT(*) AS n FROM chunks").get()
  const fpMs = performance.now() - cntT

  const truths: string[][] = []
  for (const mode of MODES) {
    process.env.CONTEXT_MRL_MIN_CORPUS = "0" // measure the path itself at every size
    setModeEnv(mode.env as unknown as Record<string, string>)
    const lat: number[] = []
    let cold = 0
    let rec = 0
    for (let i = 0; i < qvecs.length; i++) {
      const t = performance.now()
      const ids = await search(svc, qvecs[i], 10)
      const ms = performance.now() - t
      if (i === 0) cold = ms
      else lat.push(ms)
      if (mode.name === "exact") truths.push(ids)
      else rec += recall(ids, truths[i])
    }
    lat.sort((a, b) => a - b)
    rows.push({
      size,
      mode: mode.name,
      dims: mode.name === "exact" ? "-" : String(svc.lastMrlDims ?? "?"),
      cold,
      p50: pct(lat, 0.5),
      p95: pct(lat, 0.95),
      rec: mode.name === "exact" ? 1 : rec / qvecs.length,
      path: svc.lastDensePath ?? "?",
    })
  }
  delete process.env.CONTEXT_MRL_MIN_CORPUS
  console.log(`  coherence probes @ ${size.toLocaleString()}: MAX(rowid) ${maxMs.toFixed(2)} ms/query, lazy COUNT ${fpMs.toFixed(2)} ms`)
  db.close()
  return performance.now() - t0
}

function printTable(rows: Row[]): void {
  const cols = ["corpus", "mode", "dims", "cold ms", "warm p50", "warm p95", "recall@10", "path"]
  const table = rows.map((r) => [
    r.size.toLocaleString(),
    r.mode,
    r.dims,
    r.cold.toFixed(1),
    r.p50.toFixed(2),
    r.p95.toFixed(2),
    r.rec.toFixed(3),
    r.path,
  ])
  const widths = cols.map((c, i) => Math.max(c.length, ...table.map((t) => t[i].length)))
  const line = (cells: string[]) => cells.map((c, i) => c.padStart(widths[i])).join("  ")
  console.log("\n" + line(cols))
  console.log(widths.map((w) => "-".repeat(w)).join("  "))
  let prev = ""
  for (const t of table) {
    if (prev && t[0] !== prev) console.log("")
    prev = t[0]
    console.log(line(t))
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const sizesArg = args.includes("--sizes") ? args[args.indexOf("--sizes") + 1] : null
  const queries = args.includes("--queries") ? Number(args[args.indexOf("--queries") + 1]) : 0
  let sizes = sizesArg ? sizesArg.split(",").map(Number) : [1_000, 5_000, 10_000, 50_000, 100_000]

  console.log(`bench-vec: hash embedder (256d), MRL dims=${process.env.CONTEXT_MRL_DIMS || 64}, factor=${process.env.CONTEXT_MRL_FACTOR || 8}, k=10`)
  const rows: Row[] = []
  let ms100k = 0
  for (const size of sizes) {
    const q = queries || (size >= 500_000 ? 5 : size >= 100_000 ? 10 : 20)
    console.log(`\ncorpus ${size.toLocaleString()} (${q} queries)...`)
    const took = await benchSize(size, q, rows)
    if (size === 100_000) ms100k = took
  }
  // 500K only when the projection stays under ~2 minutes (ingest+queries scale ~linearly).
  if (!sizesArg && ms100k > 0) {
    const projected = (ms100k * 5.5) / 1000
    if (projected < 110) {
      console.log(`\ncorpus 500,000 (5 queries, projected ~${projected.toFixed(0)}s)...`)
      await benchSize(500_000, 5, rows)
    } else {
      console.log(`\nskipping 500K (projected ~${projected.toFixed(0)}s > budget)`)
    }
  }
  printTable(rows)
}

await main()
