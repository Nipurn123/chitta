// Regression: a DB is tied to one embedder's vector space. If the active embedder's dim
// changes between sessions (e.g. real bge-384 ↔ hashing-64), ingest must NOT crash on the
// vec0 insert — the store self-heals by reindexing to the current embedder. Reproduces the
// "expects 384, gets 64" dimension-mismatch crash reported from the MCP tools.
import { test, expect, describe } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildEmbeddedContext } from "../../src/embedded/index"
import { decodeF32 } from "../../src/embedded/store/vector-blob"
import type { EmbeddingProvider } from "../../src/provider"

// Deterministic fixed-dimension embedder (no model download), to simulate dim drift.
class FixedDim implements EmbeddingProvider {
  constructor(private readonly d: number) {}
  async embedDense(q: string): Promise<number[]> {
    const v = new Array(this.d).fill(0)
    for (let i = 0; i < q.length; i++) v[i % this.d] += q.charCodeAt(i)
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
    return v.map((x) => x / n)
  }
  async embedSparse(): Promise<{ indices: number[]; values: number[] }> {
    return { indices: [0], values: [1] }
  }
}

const storedDim = (ctx: ReturnType<typeof buildEmbeddedContext>): number => {
  const row = ctx.store.db.query("SELECT embedding FROM chunks WHERE embedding IS NOT NULL LIMIT 1").get() as
    | { embedding: Uint8Array | string }
    | undefined
  return row ? decodeF32(row.embedding).length : 0
}

describe("embedder dimension drift self-heals (no crash)", () => {
  test("reopening a 64-dim DB with a 384-dim embedder reindexes instead of throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chitta-drift-"))
    const path = join(dir, "store.db")

    // Session 1: build with a 64-dim embedder, ingest.
    const a = buildEmbeddedContext({ path, embeddings: new FixedDim(64) })
    a.ingestor.registerUser("u", "o", "u@x.com", "editor")
    await a.authorizedIngest("u", { recordId: "r1", orgId: "o", recordName: "Doc1", text: "alpha beta gamma", permittedPrincipals: [] })
    expect(storedDim(a)).toBe(64)
    a.store.close()

    // Session 2: SAME file, now a 384-dim embedder. The old crash was here on the vec0 insert.
    const b = buildEmbeddedContext({ path, embeddings: new FixedDim(384) })
    // must NOT throw — reconcile() reindexes r1 to 384, then ingests r2:
    await b.authorizedIngest("u", { recordId: "r2", orgId: "o", recordName: "Doc2", text: "delta epsilon zeta", permittedPrincipals: [] })

    // retrieval works and everything is now 384-dim (consistent space)
    const res = await b.retrieval.searchWithFilters({ queries: ["alpha beta gamma"], userId: "u", orgId: "o", limit: 5 })
    expect(res.searchResults.length).toBeGreaterThan(0)
    expect(storedDim(b)).toBe(384)
    b.store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("empty DB just adopts the current embedder dim (no reindex needed)", async () => {
    const c = buildEmbeddedContext({ path: ":memory:", embeddings: new FixedDim(128) })
    c.ingestor.registerUser("u", "o", "u@x.com", "editor")
    await c.authorizedIngest("u", { recordId: "r", orgId: "o", recordName: "D", text: "hello world", permittedPrincipals: [] })
    expect(storedDim(c)).toBe(128)
    c.store.close()
  })
})
