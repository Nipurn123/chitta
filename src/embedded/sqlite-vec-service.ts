// VectorDBService over bun:sqlite. Dense search picks a path per query:
//   1. FILTERED-EXACT - a selective ACL set becomes the search space (leak-proof, exact).
//   2. ANN            - sqlite-vec vec0 (plaintext) or libSQL native DiskANN (encrypted).
//   3. MRL TWO-STAGE  - large corpora without ANN: a Matryoshka prefix scan (stage 1,
//      first CONTEXT_MRL_DIMS dims over an in-memory cache) shortlists k*CONTEXT_MRL_FACTOR
//      candidates, then stage 2 rescores the shortlist at FULL dimension from the DB. The
//      final scores are exact - only the shortlist is approximate. Optional int8 stage-1
//      store (CONTEXT_VEC_INT8=1) for a 4x memory-bandwidth win on the scan.
//   4. EXACT          - the tuned brute-force scan (small corpora, and the fallback).
// Honors the must/should filter the retrieval spine builds: a point passes if it
// matches all `must` AND (no `should` OR matches a `should`). The `should` on
// virtualRecordId is the ACL restriction to accessible records, applied AFTER the
// ANN candidates come back (over-fetched) so recall holds under filtering. The MRL
// path applies the ACL DURING stage 1 (rows that fail never enter the shortlist),
// so filtering stays leak-proof by construction there too.

import type { VectorDBService, VectorPoint, VectorQueryResult } from "../provider"
import type { SqliteStore } from "./sqlite-store"
import { decodeF32, dot, normalize, TopK } from "./store/vector-blob"

interface EmbeddedFilter {
  must?: Record<string, unknown>
  should?: Record<string, unknown>
}

// MRL tunables (read per query so deployments/tests can flip them live).
//   CONTEXT_MRL_DIMS        requested stage-1 prefix dims (0 disables the two-stage path).
//                           A FLOOR, not a promise: calibration may raise it (below).
//   CONTEXT_MRL_FACTOR      shortlist = limit * factor
//   CONTEXT_MRL_MIN_CORPUS  below this row count exact wins (bench: exact is already
//                           low-ms at a few thousand rows; the cache + fingerprint
//                           overhead only pays off above that)
//   CONTEXT_VEC_INT8        "1" = int8 stage-1 store (Float32 rescore is unchanged)
//   CONTEXT_MRL_CALIBRATE   "0" = pin the prefix to CONTEXT_MRL_DIMS exactly (no recall
//                           calibration - bench/expert use; recall is then embedder-dependent)
const MRL_DIMS_DEFAULT = 64
const MRL_FACTOR_DEFAULT = 8
const MRL_MIN_CORPUS_DEFAULT = 4000
// Stage-1 recall floor the calibrator enforces (recall@10 of the two-stage result vs the
// exact scan). Matryoshka truncation is only sound for embedders that concentrate signal
// in the leading dims (MRL-trained / learned models); a flat-spectrum embedder (the hash
// fallback) would silently lose recall at a fixed prefix. So the cache build MEASURES
// stage-1 fidelity on a corpus sample and doubles the prefix until the target holds -
// worst case p = full dim, where stage 1 is exact-by-construction and the path degrades
// gracefully into a cached full-dim scan (still far faster than the SQL exact scan).
const MRL_RECALL_TARGET = 0.95
const MRL_CAL_QUERIES = 24
const IN_CHUNK = 900 // stay well under SQLite's default variable limit
const LOAD_PAGE = 50_000 // cache (re)build reads the table in bounded pages

function intEnv(name: string, dflt: number): number {
  const raw = process.env[name]
  if (raw == null || raw.trim() === "") return dflt
  const v = Number(raw)
  return Number.isFinite(v) ? v : dflt
}

// Tiny seeded LCG - calibration sampling must be deterministic for a given corpus so
// tests and repeated builds see the same decision.
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

// Stage-1 score of one document vector against the prefix-renormalized query, computed
// exactly the way the flat-cache scan computes it (float32 prefix-renorm, or symmetric
// per-vector int8 of the renormalized prefix). Used ONLY by the calibrator - the hot scan
// reads precomputed flat arrays instead.
function stage1ScoreRef(v: Float32Array, qp: Float32Array, p: number, int8: boolean): number {
  const lim = Math.min(p, v.length)
  let norm = 0
  for (let j = 0; j < lim; j++) norm += v[j] * v[j]
  norm = Math.sqrt(norm)
  if (norm < 1e-12) return 0
  if (!int8) {
    let s = 0
    for (let j = 0; j < lim; j++) s += v[j] * qp[j]
    return s / norm
  }
  let maxAbs = 0
  for (let j = 0; j < lim; j++) {
    const a = Math.abs(v[j])
    if (a > maxAbs) maxAbs = a
  }
  if (maxAbs === 0) return 0
  const k = 127 / maxAbs
  let s = 0
  for (let j = 0; j < lim; j++) s += Math.round(v[j] * k) * qp[j]
  return s * (maxAbs / (127 * norm))
}

// In-memory stage-1 scan cache: the prefix of every stored embedding, PREFIX-RENORMALIZED
// (dot on a raw prefix of a unit vector is NOT the cosine of the truncated embedding - short
// prefixes with small norms would be systematically under-scored, so each prefix is divided
// by its own norm once at build time). Stored flat (n*p) for cache-friendly scanning:
// ~256 MB at 1M vectors for float32 p=64, ~64 MB for int8. Nothing is persisted - the cache
// rebuilds from the chunks table and stays coherent via a (COUNT, MAX(rowid)) fingerprint.
interface ScanCache {
  reqP: number // requested prefix dims (env) - part of the cache key
  factor: number // shortlist factor the calibration assumed - part of the cache key
  p: number // CALIBRATED prefix dims actually stored (reqP <= p <= full dim)
  int8: boolean // stage-1 store is int8-quantized
  n: number // rows in the arrays (live + tolerated-stale)
  count: number // live chunk COUNT at last sync
  maxRowid: number
  cap: number // allocated rows in the typed arrays
  rowids: number[]
  vids: Array<string | null> // interned - one string instance per distinct vid
  orgs: Array<string | null>
  pf: Float32Array | null // float32 prefix store (n*p), prefix-renormalized
  q8: Int8Array | null // int8 prefix store (n*p), symmetric per-vector quantization
  s8: Float32Array | null // per-row dequant scale (folds the prefix renorm in)
  intern: Map<string, string>
}

export class SqliteVecService implements VectorDBService {
  /** Which dense path served the LAST query - instrumentation for tests/bench. */
  lastDensePath: "ann" | "filtered-exact" | "mrl" | "mrl-int8" | "exact" | null = null
  /** Calibrated stage-1 prefix dims of the live cache (null = no cache) - instrumentation. */
  lastMrlDims: number | null = null
  private cache: ScanCache | null = null

  constructor(private readonly store: SqliteStore) {}

  async filterCollection(args: {
    must?: Record<string, unknown>
    should?: Record<string, unknown>
  }): Promise<EmbeddedFilter> {
    return { must: args.must, should: args.should }
  }

  async queryNearestPoints(args: {
    collectionName: string
    requests: unknown[]
  }): Promise<VectorQueryResult[]> {
    return args.requests.map((reqUnknown) => {
      const req = reqUnknown as {
        prefetch?: Array<{ query: unknown; using?: string }>
        filter?: EmbeddedFilter
        limit?: number
      }
      const dense = (req.prefetch?.find((p) => p.using === "dense")?.query ?? req.prefetch?.[0]?.query) as number[]
      const filter = req.filter ?? {}
      const limit = req.limit ?? 20
      const mustOrg = filter.must?.["orgId"] as string | undefined
      // Prefer the pre-built (memoized) ACL set threaded from the retrieval spine - avoids an
      // O(N) Set rebuild per query. Fall back to the id array (cloud filter shape).
      const allowedSet = filter.should?.["virtualRecordIdSet"] as ReadonlySet<string> | undefined
      const allowedVids = filter.should?.["virtualRecordId"] as string[] | undefined
      const allowed = allowedSet ?? (allowedVids ? new Set(allowedVids) : undefined)

      // FILTERED-ANN (ACORN / Filtered-DiskANN principle): when the ACL filter is SELECTIVE - the
      // user can see only a bounded set - make the permission set the SEARCH SPACE. Scanning
      // exactly those vectors is cheaper (O(accessible) via idx_chunks_vid) AND higher-recall
      // (EXACT - no over-fetched global ANN that returns mostly-inaccessible rows and truncates the
      // accessible ones). The permission gate stops being a post-filter and becomes the candidate
      // generator. Above the threshold (e.g. an admin who sees everything) we keep the ANN path.
      const ff = Number(process.env.CONTEXT_FILTER_FIRST_MAX ?? 2000)
      if (dense && allowed && allowed.size > 0 && allowed.size <= ff) {
        this.lastDensePath = "filtered-exact"
        return { points: this.filteredExact(dense, mustOrg, allowed, limit) }
      }

      // Try ANN (vec0 plaintext OR libSQL native DiskANN under encryption); fall back to
      // the fast BLOB brute-force when the index can't serve (missing / not yet built /
      // written by a non-vec store). Guarantees we never miss rows that exist in `chunks`.
      let points = this.store.annEnabled && dense ? this.annQuery(dense, mustOrg, allowed, limit) : []
      if (points.length > 0) this.lastDensePath = "ann"
      if (points.length === 0) points = this.bruteForce(dense, mustOrg, allowed, limit)
      return { points }
    })
  }

  // Fast path: ANN candidates from vec0, over-fetched then ACL-filtered.
  private annQuery(
    dense: number[],
    mustOrg: string | undefined,
    allowed: ReadonlySet<string> | undefined,
    limit: number,
  ): VectorPoint[] {
    const knn = this.store.knnSearch(dense, Math.max(limit * 20, 50))
    if (knn.length === 0) return []
    const byRowid = new Map(knn.map((k) => [k.rowid, k.distance]))
    const rows = this.store.db
      .query(`SELECT rowid, point_id, virtual_record_id, org_id, content FROM chunks WHERE rowid IN (${knn.map(() => "?").join(",")})`)
      .all(...knn.map((k) => k.rowid)) as Array<{
      rowid: number
      point_id: string
      virtual_record_id: string
      org_id: string
      content: string
    }>
    const out: VectorPoint[] = []
    for (const c of rows) {
      if (mustOrg != null && c.org_id !== mustOrg) continue
      if (allowed && !allowed.has(c.virtual_record_id)) continue
      out.push({
        id: c.point_id,
        score: 1 - (byRowid.get(c.rowid) ?? 1), // cosine distance → similarity
        payload: { page_content: c.content, metadata: { virtualRecordId: c.virtual_record_id, orgId: c.org_id } },
      })
    }
    out.sort((a, b) => b.score - a.score)
    return out.slice(0, limit)
  }

  // FILTERED-ANN fast path: EXACT top-k over ONLY the accessible chunks. Bounded by |accessible|
  // (fetched via idx_chunks_vid), so O(accessible) not O(all chunks) - and exact, so a scoped user
  // never loses a relevant hit to ANN over-fetch truncation. IN-list is chunked under SQLite's
  // variable cap. Same scoring (dot on unit-normalized vectors == cosine) as the other paths.
  private filteredExact(dense: number[], mustOrg: string | undefined, allowed: ReadonlySet<string>, limit: number): VectorPoint[] {
    const vids = [...allowed]
    const q = normalize(dense)
    const top = new TopK<{ point_id: string; content: string; vid: string; org: string }>(limit)
    for (let i = 0; i < vids.length; i += IN_CHUNK) {
      const slice = vids.slice(i, i + IN_CHUNK)
      const rows = this.store.db
        .query(
          `SELECT point_id, virtual_record_id, org_id, content, embedding FROM chunks WHERE virtual_record_id IN (${slice.map(() => "?").join(",")})`,
        )
        .all(...slice) as Array<{ point_id: string; virtual_record_id: string; org_id: string; content: string; embedding: Uint8Array | string }>
      for (const c of rows) {
        if (mustOrg != null && c.org_id !== mustOrg) continue
        top.offer(dot(q, decodeF32(c.embedding)), { point_id: c.point_id, content: c.content, vid: c.virtual_record_id, org: c.org_id })
      }
    }
    return top.values().map(({ score, value }) => ({
      id: value.point_id,
      score,
      payload: { page_content: value.content, metadata: { virtualRecordId: value.vid, orgId: value.org } },
    }))
  }

  // Fallback: scan in TS (portable, no extension needed) - but fast. Embeddings are read
  // as Float32 BLOBs (zero-copy, no JSON.parse), scored by dot product against the
  // unit-normalized query (dot == cosine for our normalized embedders), and only the top-k
  // are kept via a bounded selector (no full O(N log N) sort of the whole corpus).
  // Above CONTEXT_MRL_MIN_CORPUS rows the Matryoshka two-stage path takes over.
  private bruteForce(
    dense: number[] | undefined,
    mustOrg: string | undefined,
    allowed: ReadonlySet<string> | undefined,
    limit: number,
  ): VectorPoint[] {
    if (!dense) return []
    const mrl = this.twoStage(dense, mustOrg, allowed, limit)
    if (mrl) return mrl
    this.lastDensePath = "exact"
    const q = normalize(dense)
    const rows = this.store.db
      .query("SELECT point_id, virtual_record_id, org_id, content, embedding FROM chunks")
      .all() as Array<{ point_id: string; virtual_record_id: string; org_id: string; content: string; embedding: Uint8Array | string }>
    const top = new TopK<{ point_id: string; content: string; vid: string; org: string }>(limit)
    for (const c of rows) {
      if (mustOrg != null && c.org_id !== mustOrg) continue
      if (allowed && !allowed.has(c.virtual_record_id)) continue
      top.offer(dot(q, decodeF32(c.embedding)), { point_id: c.point_id, content: c.content, vid: c.virtual_record_id, org: c.org_id })
    }
    return top.values().map(({ score, value }) => ({
      id: value.point_id,
      score,
      payload: { page_content: value.content, metadata: { virtualRecordId: value.vid, orgId: value.org } },
    }))
  }

  // ── MRL two-stage scan ────────────────────────────────────────────────────
  // Stage 1 scores EVERY (filter-passing) row on the first `p` dims from the in-memory
  // cache and keeps a shortlist of limit*factor row indices. Stage 2 re-fetches only the
  // shortlist from SQLite and rescores at FULL dimension - so the returned scores are the
  // exact cosine, and recall loss can only come from a true neighbour missing the
  // shortlist. `p` comes from the recall calibration (>= MRL_RECALL_TARGET by construction,
  // measured in tools/bench-vec.ts). Returns null when the path shouldn't serve (disabled,
  // corpus below CONTEXT_MRL_MIN_CORPUS, shortlist ~ corpus, degenerate query prefix) -
  // the caller then runs the exact scan.
  private twoStage(
    dense: number[],
    mustOrg: string | undefined,
    allowed: ReadonlySet<string> | undefined,
    limit: number,
  ): VectorPoint[] | null {
    const reqP = intEnv("CONTEXT_MRL_DIMS", MRL_DIMS_DEFAULT)
    if (reqP <= 0) return null // explicitly disabled
    const minCorpus = intEnv("CONTEXT_MRL_MIN_CORPUS", MRL_MIN_CORPUS_DEFAULT)
    const fp = this.fingerprint()
    if (fp.n < minCorpus) return null // small corpus: exact is faster than cache upkeep
    const factor = Math.max(2, intEnv("CONTEXT_MRL_FACTOR", MRL_FACTOR_DEFAULT))
    const shortK = limit * factor
    if (shortK >= fp.n) return null // shortlist would be ~the whole corpus - just scan exact
    const int8 = process.env.CONTEXT_VEC_INT8 === "1"
    const cache = this.syncCache(reqP, factor, int8, fp.n, fp.m)
    if (!cache || cache.n === 0) return null
    const p = cache.p // calibrated prefix dims

    // Renormalize the QUERY prefix too - both sides of the stage-1 dot must be unit
    // vectors for the score to be the cosine of the truncated pair. qp is zero-padded
    // when the calibrated prefix exceeds the query dim (legacy shorter embedders).
    const qFull = normalize(dense)
    const qLim = Math.min(p, qFull.length)
    let qn = 0
    for (let j = 0; j < qLim; j++) qn += qFull[j] * qFull[j]
    qn = Math.sqrt(qn)
    if (qn < 1e-9) return null // no signal in the prefix - let exact handle it
    const qp = new Float32Array(p)
    for (let j = 0; j < qLim; j++) qp[j] = qFull[j] / qn

    // Stage 1: filtered prefix scan → shortlist of row indices. ACL/org checks run HERE,
    // before the shortlist, so an inaccessible row can never crowd out an accessible one
    // (and can never surface: stage 2 re-checks against fresh DB rows anyway).
    const top = new TopK<number>(shortK)
    const { n, vids, orgs } = cache
    if (int8) {
      const q8 = cache.q8!
      const s8 = cache.s8!
      for (let i = 0; i < n; i++) {
        if (mustOrg != null && orgs[i] !== mustOrg) continue
        if (allowed) {
          const vid = vids[i]
          if (vid == null || !allowed.has(vid)) continue
        }
        const off = i * p
        let s = 0
        let j = 0
        for (; j + 3 < p; j += 4)
          s += q8[off + j] * qp[j] + q8[off + j + 1] * qp[j + 1] + q8[off + j + 2] * qp[j + 2] + q8[off + j + 3] * qp[j + 3]
        for (; j < p; j++) s += q8[off + j] * qp[j]
        top.offer(s * s8[i], i)
      }
    } else {
      const pf = cache.pf!
      for (let i = 0; i < n; i++) {
        if (mustOrg != null && orgs[i] !== mustOrg) continue
        if (allowed) {
          const vid = vids[i]
          if (vid == null || !allowed.has(vid)) continue
        }
        const off = i * p
        let s = 0
        let j = 0
        for (; j + 3 < p; j += 4)
          s += pf[off + j] * qp[j] + pf[off + j + 1] * qp[j + 1] + pf[off + j + 2] * qp[j + 2] + pf[off + j + 3] * qp[j + 3]
        for (; j < p; j++) s += pf[off + j] * qp[j]
        top.offer(s, i)
      }
    }
    const short = top.values()
    // Empty shortlist ⇒ no row passed the filters - exact would return [] too.
    const points = short.length === 0 ? [] : this.rescoreShortlist(short.map((s) => cache.rowids[s.value]), qFull, mustOrg, allowed, limit)
    this.lastDensePath = int8 ? "mrl-int8" : "mrl"
    this.lastMrlDims = p
    return points
  }

  // Stage 2: fetch ONLY the shortlist rows (chunked IN-list on rowid) and rescore at full
  // dimension - identical scoring to the exact path, so the top-k of the shortlist IS the
  // exact ranking of those candidates. Fetching by rowid also self-heals cache staleness:
  // a row deleted or replaced since the cache was built simply isn't there anymore, so a
  // forgotten chunk can never resurface from the cache (only its live DB row can score).
  private rescoreShortlist(
    rowids: number[],
    qFull: Float32Array,
    mustOrg: string | undefined,
    allowed: ReadonlySet<string> | undefined,
    limit: number,
  ): VectorPoint[] {
    const top = new TopK<{ point_id: string; content: string; vid: string; org: string }>(limit)
    for (let i = 0; i < rowids.length; i += IN_CHUNK) {
      const slice = rowids.slice(i, i + IN_CHUNK)
      const rows = this.store.db
        .query(
          `SELECT point_id, virtual_record_id, org_id, content, embedding FROM chunks WHERE rowid IN (${slice.map(() => "?").join(",")})`,
        )
        .all(...slice) as Array<{ point_id: string; virtual_record_id: string; org_id: string; content: string; embedding: Uint8Array | string }>
      for (const c of rows) {
        if (mustOrg != null && c.org_id !== mustOrg) continue
        if (allowed && !allowed.has(c.virtual_record_id)) continue
        top.offer(dot(qFull, decodeF32(c.embedding)), { point_id: c.point_id, content: c.content, vid: c.virtual_record_id, org: c.org_id })
      }
    }
    return top.values().map(({ score, value }) => ({
      id: value.point_id,
      score,
      payload: { page_content: value.content, metadata: { virtualRecordId: value.vid, orgId: value.org } },
    }))
  }

  // ── scan-cache lifecycle ──────────────────────────────────────────────────
  // Coherence fingerprint. MAX(rowid) is O(log N) and catches every write path that adds
  // data: plain inserts AND replaces (INSERT OR REPLACE always allocates a fresh rowid, so
  // MAX grows). COUNT(*) is an O(N) index scan (bench: ~28ms at 500K - real money at scale),
  // and its only job is catching PURE deletes (the forget path), which are already
  // structurally safe: stage 2 refetches by rowid, so a deleted row can never resurface
  // from a stale cache - it can only waste shortlist slots. So COUNT runs lazily: whenever
  // MAX moved (ingest is when replaces happen anyway), when there is no cache yet, and at
  // worst every 32 queries - bounding how long a delete-only storm can dilute the shortlist
  // before the staleness rebuild sees it.
  private fpTick = 0
  private fingerprint(): { n: number; m: number } {
    const m = (this.store.db.query("SELECT COALESCE(MAX(rowid), 0) AS m FROM chunks").get() as { m: number }).m
    const c = this.cache
    if (c && m === c.maxRowid && (this.fpTick = (this.fpTick + 1) & 31) !== 0) return { n: c.count, m }
    const n = (this.store.db.query("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n
    return { n, m }
  }
  // Sync the cache to the fingerprint. Full rebuild when: shape changed (requested dims /
  // factor / int8 mode), rows were net-deleted (COUNT dropped - keeps forget-flows tight),
  // the rowid space moved backwards (different/vacuumed DB), or tolerated staleness from
  // replaces exceeded ~12%. Otherwise APPEND only the new rows (rowid > cached max), so
  // steady ingest doesn't re-decode the whole corpus. Replaced rows linger as stale
  // stage-1 entries until the rebuild threshold - harmless, because stage 2 refetches by
  // rowid and a vanished rowid returns nothing.
  private syncCache(reqP: number, factor: number, int8: boolean, count: number, maxRowid: number): ScanCache | null {
    let c = this.cache
    const incompatible = !c || c.reqP !== reqP || c.factor !== factor || c.int8 !== int8 || maxRowid < c.maxRowid || count < c.count
    if (incompatible) {
      const p = this.calibrate(reqP, factor, int8, count, maxRowid)
      c = {
        reqP,
        factor,
        p,
        int8,
        n: 0,
        count: 0,
        maxRowid: 0,
        cap: 0,
        rowids: [],
        vids: [],
        orgs: [],
        pf: null,
        q8: null,
        s8: null,
        intern: new Map(),
      }
      this.growCache(c, Math.max(count, 64))
      this.loadRows(c, 0)
      this.cache = c
    } else if (maxRowid > c!.maxRowid) {
      this.loadRows(c!, c!.maxRowid)
    }
    c = this.cache!
    c.count = count
    c.maxRowid = maxRowid
    this.lastMrlDims = c.p
    if (c.n - c.count > Math.max(64, c.count >> 3)) {
      // too many stale (replaced-away) entries wasting stage-1 work - rebuild fresh
      this.cache = null
      return this.syncCache(reqP, factor, int8, count, maxRowid)
    }
    return c
  }

  // ── stage-1 recall calibration ────────────────────────────────────────────
  // Decide how deep the stage-1 prefix must be FOR THIS CORPUS + EMBEDDER. Draws a
  // deterministic sample, uses sampled vectors as pseudo-queries, and checks: of each
  // pseudo-query's exact top-10 (full-dim), what fraction would survive a stage-1
  // shortlist of limit*factor? Because a sample of R rows stands in for N, the corpus
  // shortlist L scales down to a sample rank threshold t = L*R/N (an impostor that
  // outranks a true hit in the sample represents N/R of them in the corpus). Doubles the
  // prefix until the estimate clears MRL_RECALL_TARGET; worst case returns the full dim,
  // where stage 1 is the exact cosine (float) and the path is a cached full-dim scan.
  private calibrate(reqP: number, factor: number, int8: boolean, count: number, maxRowid: number): number {
    if (process.env.CONTEXT_MRL_CALIBRATE === "0") return reqP
    const sample = this.sampleVectors(count, maxRowid)
    if (sample.length < 100) return reqP // not enough signal to calibrate (tiny/fragmented corpus)
    const dim = sample.reduce((m, v) => Math.max(m, v.length), 0)
    if (dim === 0) return reqP
    const R = sample.length
    const t = Math.max(1, Math.round((10 * factor * R) / count))
    const S = Math.min(MRL_CAL_QUERIES, R >> 2)
    let p = Math.min(reqP, dim)
    while (p < dim) {
      if (this.estimateStage1Recall(sample, S, p, t, int8) >= MRL_RECALL_TARGET) return p
      p = Math.min(dim, p * 2)
    }
    return dim // no truncation is trustworthy here - full-dim cached scan (exact stage 1)
  }

  // Deterministic corpus sample for calibration: all embeddings when the corpus is small,
  // else uniform random rowids (seeded). R grows as N/16 (capped) so the rank threshold
  // t = 10*factor*R/N keeps enough resolution to measure the shortlist boundary.
  private sampleVectors(count: number, maxRowid: number): Float32Array[] {
    const targetR = Math.max(1000, Math.min(64_000, Math.ceil(count / 16)))
    const out: Float32Array[] = []
    if (count <= targetR) {
      const q = this.store.db.query(
        `SELECT rowid, embedding FROM chunks WHERE rowid > ? AND embedding IS NOT NULL ORDER BY rowid LIMIT ${LOAD_PAGE}`,
      )
      let last = 0
      for (;;) {
        const rows = q.all(last) as Array<{ rowid: number; embedding: Uint8Array | string }>
        if (rows.length === 0) break
        for (const r of rows) out.push(decodeF32(r.embedding))
        last = rows[rows.length - 1].rowid
        if (rows.length < LOAD_PAGE) break
      }
    } else {
      const rnd = lcg(0x5eed ^ count)
      const want = new Set<number>()
      while (want.size < targetR) want.add(1 + Math.floor(rnd() * maxRowid))
      const ids = [...want]
      for (let i = 0; i < ids.length; i += IN_CHUNK) {
        const slice = ids.slice(i, i + IN_CHUNK)
        const rows = this.store.db
          .query(`SELECT embedding FROM chunks WHERE rowid IN (${slice.map(() => "?").join(",")}) AND embedding IS NOT NULL`)
          .all(...slice) as Array<{ embedding: Uint8Array | string }>
        for (const r of rows) out.push(decodeF32(r.embedding))
      }
    }
    // Seeded shuffle so the pseudo-queries (the first S entries) aren't biased toward
    // the oldest rows when the whole corpus was read in rowid order.
    const rnd = lcg(0xc0ffee ^ out.length)
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      const tmp = out[i]
      out[i] = out[j]
      out[j] = tmp
    }
    return out
  }

  // Estimated recall@10-vs-exact of a stage-1 shortlist at prefix p within the sample:
  // for each pseudo-query, take its exact top-10 among the sample, then check how many
  // sit within the top-t of the STAGE-1 ordering (t = corpus shortlist scaled to the
  // sample). Scores are computed exactly as the hot scan computes them (incl. the int8
  // quantization when that mode is on), so the estimate reflects the real path.
  private estimateStage1Recall(sample: Float32Array[], S: number, p: number, t: number, int8: boolean): number {
    const R = sample.length
    let hits = 0
    let total = 0
    const s1 = new Float64Array(R)
    for (let s = 0; s < S; s++) {
      const qFull = normalize(sample[s])
      const qLim = Math.min(p, qFull.length)
      let qn = 0
      for (let j = 0; j < qLim; j++) qn += qFull[j] * qFull[j]
      qn = Math.sqrt(qn)
      if (qn < 1e-9) continue
      const qp = new Float32Array(p)
      for (let j = 0; j < qLim; j++) qp[j] = qFull[j] / qn
      // exact top-10 (the truth) and stage-1 scores in one pass over the sample
      const exactTop = new TopK<number>(10)
      for (let i = 0; i < R; i++) {
        if (i === s) {
          s1[i] = -Infinity
          continue
        }
        exactTop.offer(dot(qFull, sample[i]), i)
        s1[i] = stage1ScoreRef(sample[i], qp, p, int8)
      }
      for (const { value: idx } of exactTop.values()) {
        // sample rank of the true hit under stage-1 ordering (1 = best)
        let rank = 1
        const si = s1[idx]
        for (let i = 0; i < R; i++) if (s1[i] > si) rank++
        if (rank <= t) hits++
        total++
      }
    }
    return total === 0 ? 1 : hits / total
  }

  // Page through chunks after `afterRowid` (0 = everything) and append to the cache.
  // Paged so a million-row build never materializes the whole table in one .all().
  private loadRows(c: ScanCache, afterRowid: number): void {
    const q = this.store.db.query(
      `SELECT rowid, virtual_record_id, org_id, embedding FROM chunks WHERE rowid > ? AND embedding IS NOT NULL ORDER BY rowid LIMIT ${LOAD_PAGE}`,
    )
    let last = afterRowid
    for (;;) {
      const rows = q.all(last) as Array<{
        rowid: number
        virtual_record_id: string | null
        org_id: string | null
        embedding: Uint8Array | string
      }>
      if (rows.length === 0) break
      for (const r of rows) this.pushRow(c, r.rowid, r.virtual_record_id, r.org_id, r.embedding)
      last = rows[rows.length - 1].rowid
      if (rows.length < LOAD_PAGE) break
    }
  }

  // Append one row: decode the BLOB, renormalize its first `p` dims (prefix cosine needs
  // the PREFIX norm, not the full-vector norm), store float32 or symmetric-int8. Vectors
  // shorter than `p` (legacy embedders) zero-pad naturally - typed arrays start zeroed and
  // slots are written once.
  private pushRow(c: ScanCache, rowid: number, vid: string | null, org: string | null, blob: Uint8Array | string): void {
    if (c.n === c.cap) this.growCache(c, c.cap * 2)
    const v = decodeF32(blob)
    const off = c.n * c.p
    const lim = Math.min(c.p, v.length)
    let norm = 0
    for (let j = 0; j < lim; j++) norm += v[j] * v[j]
    norm = Math.sqrt(norm)
    if (c.int8) {
      // Symmetric per-vector quantization of the RENORMALIZED prefix: q = round(x*127/maxAbs),
      // dequant scale (maxAbs/(127*norm)) folded per row so stage-1 score = intdot * s8[i].
      let maxAbs = 0
      for (let j = 0; j < lim; j++) {
        const a = Math.abs(v[j])
        if (a > maxAbs) maxAbs = a
      }
      if (norm >= 1e-12 && maxAbs > 0) {
        const k = 127 / maxAbs
        for (let j = 0; j < lim; j++) c.q8![off + j] = Math.round(v[j] * k)
        c.s8![c.n] = maxAbs / (127 * norm)
      } // else: all-zero prefix - q8 slots stay 0, s8 stays 0, row scores 0 in stage 1
    } else if (norm >= 1e-12) {
      const inv = 1 / norm
      for (let j = 0; j < lim; j++) c.pf![off + j] = v[j] * inv
    }
    c.rowids.push(rowid)
    c.vids.push(vid == null ? null : this.intern(c, vid))
    c.orgs.push(org == null ? null : this.intern(c, org))
    c.n++
  }

  private growCache(c: ScanCache, cap: number): void {
    if (cap <= c.cap) return
    if (c.int8) {
      const q8 = new Int8Array(cap * c.p)
      if (c.q8) q8.set(c.q8)
      c.q8 = q8
      const s8 = new Float32Array(cap)
      if (c.s8) s8.set(c.s8)
      c.s8 = s8
    } else {
      const pf = new Float32Array(cap * c.p)
      if (c.pf) pf.set(c.pf)
      c.pf = pf
    }
    c.cap = cap
  }

  // Intern vid/org strings so 1M cache rows hold one string instance per DISTINCT value
  // (the scan then mostly does reference-equality compares).
  private intern(c: ScanCache, s: string): string {
    const hit = c.intern.get(s)
    if (hit) return hit
    c.intern.set(s, s)
    return s
  }
}
