// Scale paths for dense search (Matryoshka two-stage + optional int8 stage-1 store):
// recall@10 gate vs the exact scan, the auto-disable threshold, cache freshness under
// ingest/forget, and ACL leak-proofness when the two-stage path serves a filtered query.
// Uses the deterministic hash embedder; resetVec() drops the vec0 index after ingest so
// queries exercise the real fallback chain (ANN empty → brute force → MRL two-stage).

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { SqliteStore } from "../../src/embedded/sqlite-store"
import { SqliteVecService } from "../../src/embedded/sqlite-vec-service"
import { LocalHashEmbeddings } from "../../src/embedded/local-embeddings"

const ENV_KEYS = [
  "CONTEXT_MRL_DIMS",
  "CONTEXT_MRL_FACTOR",
  "CONTEXT_MRL_MIN_CORPUS",
  "CONTEXT_VEC_INT8",
  "CONTEXT_MRL_CALIBRATE",
  "CONTEXT_FILTER_FIRST_MAX",
] as const
const saved: Record<string, string | undefined> = {}

// Each test declares its FULL env (unlisted keys are cleared) so tests are order-independent.
function setEnv(vals: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const k of ENV_KEYS) delete process.env[k]
  for (const [k, v] of Object.entries(vals)) process.env[k] = v
}

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

const VOCAB = Array.from({ length: 2500 }, (_, i) => `tok${i}x`)
const N = 5000
const Q = 25
const emb = new LocalHashEmbeddings()

let store: SqliteStore
let svc: SqliteVecService
const docs: string[] = []
const qvecs: number[][] = []

async function search(vec: number[], limit = 10, should?: Record<string, unknown>): Promise<string[]> {
  const [res] = await svc.queryNearestPoints({
    collectionName: "t",
    requests: [{ prefetch: [{ query: vec, using: "dense" }], limit, filter: { must: { orgId: "o" }, should } }],
  })
  return res.points.map((p) => String(p.id))
}

function recall(got: string[], truth: string[]): number {
  const t = new Set(truth)
  return got.filter((id) => t.has(id)).length / Math.max(1, truth.length)
}

async function avgRecall(should?: Record<string, unknown>): Promise<number> {
  // exact truth first (same filter), then the path under test - envs set by the caller
  const dims = process.env.CONTEXT_MRL_DIMS
  process.env.CONTEXT_MRL_DIMS = "0"
  const truths: string[][] = []
  for (const q of qvecs) truths.push(await search(q, 10, should))
  if (dims == null) delete process.env.CONTEXT_MRL_DIMS
  else process.env.CONTEXT_MRL_DIMS = dims
  let r = 0
  for (let i = 0; i < qvecs.length; i++) r += recall(await search(qvecs[i], 10, should), truths[i])
  return r / qvecs.length
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  store = new SqliteStore(":memory:")
  const rnd = mulberry32(7)
  for (let i = 0; i < N; i++) {
    const words: string[] = []
    for (let w = 0; w < 12; w++) words.push(VOCAB[Math.floor(rnd() * VOCAB.length)])
    const text = words.join(" ")
    docs.push(text)
    store.addChunk(`p${i}`, `vid${i}`, "o", text, await emb.embedDense(text))
  }
  store.resetVec() // force the brute-force chain (vec0 would otherwise serve)
  svc = new SqliteVecService(store)
  const qrnd = mulberry32(99)
  for (let i = 0; i < Q; i++) {
    const words = docs[Math.floor(qrnd() * N)].split(" ")
    const picked: string[] = []
    for (let w = 0; w < 6; w++) picked.push(words[Math.floor(qrnd() * words.length)])
    qvecs.push(await emb.embedQuery(picked.join(" ")))
  }
})

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] == null) delete process.env[k]
    else process.env[k] = saved[k]
  }
  store.close()
})

describe("MRL two-stage dense search at scale", () => {
  test("two-stage recall@10 >= 0.95 vs exact on a 5K corpus", async () => {
    setEnv({ CONTEXT_MRL_MIN_CORPUS: "0" })
    const r = await avgRecall()
    expect(svc.lastDensePath).toBe("mrl")
    expect(r).toBeGreaterThanOrEqual(0.95)
  })

  test("int8 stage-1 recall@10 >= 0.95 vs exact on a 5K corpus", async () => {
    setEnv({ CONTEXT_MRL_MIN_CORPUS: "0", CONTEXT_VEC_INT8: "1" })
    const r = await avgRecall()
    expect(svc.lastDensePath).toBe("mrl-int8")
    expect(r).toBeGreaterThanOrEqual(0.95)
  })

  test("auto-disables below CONTEXT_MRL_MIN_CORPUS (exact results, exact path)", async () => {
    setEnv({ CONTEXT_MRL_MIN_CORPUS: "0" })
    const viaMrl = await search(qvecs[0])
    expect(svc.lastDensePath).toBe("mrl")
    setEnv({ CONTEXT_MRL_MIN_CORPUS: "1000000" })
    const viaExact = await search(qvecs[0])
    expect(svc.lastDensePath).toBe("exact")
    // and the shipped default threshold itself disables tiny corpora: a fresh 3-row store
    const tiny = new SqliteStore(":memory:")
    for (let i = 0; i < 3; i++) tiny.addChunk(`t${i}`, `tv${i}`, "o", `doc ${i}`, await emb.embedDense(`doc ${i}`))
    tiny.resetVec()
    const tinySvc = new SqliteVecService(tiny)
    setEnv({})
    const [tr] = await tinySvc.queryNearestPoints({
      collectionName: "t",
      requests: [{ prefetch: [{ query: qvecs[0], using: "dense" }], limit: 2, filter: { must: { orgId: "o" } } }],
    })
    expect(tinySvc.lastDensePath).toBe("exact")
    expect(tr.points.length).toBeGreaterThan(0)
    tiny.close()
    // the calibrated two-stage rescores at full dimension, so its top-10 matches exact
    expect(viaMrl).toEqual(viaExact)
  })

  test("ACL filtering stays leak-proof through the two-stage path (float and int8)", async () => {
    // Even vids only; FILTER_FIRST_MAX=0 pushes the query past the filtered-exact path
    // into the brute/MRL path, where the ACL must be applied during stage 1.
    const allowed = new Set<string>()
    for (let i = 0; i < N; i += 2) allowed.add(`vid${i}`)
    const should = { virtualRecordIdSet: allowed }
    for (const int8 of ["", "1"]) {
      setEnv({ CONTEXT_MRL_MIN_CORPUS: "0", CONTEXT_FILTER_FIRST_MAX: "0", ...(int8 ? { CONTEXT_VEC_INT8: int8 } : {}) })
      const r = await avgRecall(should)
      expect(svc.lastDensePath).toBe(int8 ? "mrl-int8" : "mrl")
      expect(r).toBeGreaterThanOrEqual(0.95)
      for (const q of qvecs.slice(0, 5)) {
        const ids = await search(q, 10, should)
        expect(ids.length).toBeGreaterThan(0)
        // every result is an allowed (even) vid - odd rows never surface
        for (const id of ids) expect(Number(id.slice(1)) % 2).toBe(0)
      }
    }
  })

  test("fresh ingest is visible immediately and forgotten rows never resurface", async () => {
    setEnv({ CONTEXT_MRL_MIN_CORPUS: "0" })
    await search(qvecs[0]) // build the cache
    const text = "zebra quokka axolotl wombat narwhal pangolin unique sentinel chunk"
    const vec = await emb.embedDense(text)
    store.addChunk("p-fresh", "vid-fresh", "o", text, vec)
    store.resetVec() // addChunk resurrects the vec0 index - drop it again to stay on brute force
    const ids = await search(vec)
    expect(svc.lastDensePath).toBe("mrl")
    expect(ids[0]).toBe("p-fresh") // identical vector ranks first, through the stale-cache append
    // forget it: the row disappears from the DB; stage 2 refetches by rowid so even a
    // stale stage-1 cache entry cannot bring it back
    store.db.query("DELETE FROM chunks WHERE point_id = ?").run("p-fresh")
    const after = await search(vec)
    expect(after).not.toContain("p-fresh")
  })
})
