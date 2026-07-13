// Resumable reindex: after an embedder change, `reindex()` must re-embed ONLY the stale-dim
// items and REUSE those already at the current dim, report progress, and leave the store
// consistent. This is what lets a large migration - or one interrupted half-way (mixed dims) -
// finish by doing only what's left, and what keeps a big store from being re-embedded from zero.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildEmbeddedContext } from "../../src/embedded/index"
import { decodeF32 } from "../../src/embedded/store/vector-blob"
import type { EmbeddingProvider } from "../../src/provider"

// A fixed-dim embedder that COUNTS how many times it embeds, so we can prove reuse (not re-embed).
class CountingDim implements EmbeddingProvider {
  embeds = 0
  constructor(private readonly d: number) {}
  async embedDense(q: string): Promise<number[]> {
    this.embeds++
    const v = new Array(this.d).fill(0)
    for (let i = 0; i < q.length; i++) v[i % this.d] += q.charCodeAt(i)
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
    return v.map((x) => x / n)
  }
  async embedSparse() {
    return { indices: [0], values: [1] }
  }
}

const dimsInStore = (ctx: ReturnType<typeof buildEmbeddedContext>): Set<number> => {
  const rows = ctx.store.db.query("SELECT DISTINCT length(embedding) b FROM chunks WHERE embedding IS NOT NULL").all() as Array<{ b: number }>
  return new Set(rows.map((r) => r.b / 4))
}

describe("resumable reindex", () => {
  test("re-embeds only stale-dim items, reuses current-dim ones, reports progress, ends consistent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chitta-reindex-"))
    const path = join(dir, "s.db")

    // Build a store at 32-dim with several records.
    const e32 = new CountingDim(32)
    const a = buildEmbeddedContext({ path, embeddings: e32 })
    a.ingestor.registerUser("u", "o", "u@x.com", "editor")
    for (let i = 0; i < 6; i++) {
      await a.authorizedIngest("u", { recordId: `r${i}`, orgId: "o", recordName: `Doc${i}`, text: `alpha beta gamma number ${i} lorem ipsum`, permittedPrincipals: [] })
    }
    const chunkCount = (a.store.db.query("SELECT count(*) c FROM chunks").get() as { c: number }).c
    const memCount = a.store.memories.all().length
    expect(chunkCount).toBeGreaterThan(0)
    a.store.close()

    // Reopen at 64-dim and reindex with a FRESH counter, tracking progress callbacks.
    const e64 = new CountingDim(64)
    const b = buildEmbeddedContext({ path, embeddings: e64 })
    e64.embeds = 0
    const seen: Array<[number, number]> = []
    const stats = await b.reindex((done, total) => seen.push([done, total]))

    // everything re-embedded (all were 32-dim), nothing reused, store now uniformly 64-dim
    expect(stats.total).toBe(chunkCount + memCount)
    expect(stats.reembedded).toBe(chunkCount + memCount)
    expect(stats.reused).toBe(0)
    expect(dimsInStore(b)).toEqual(new Set([64]))
    // progress went 1..total monotonically and ended at total (plus one probe embed)
    expect(seen.length).toBe(stats.total)
    expect(seen.at(-1)).toEqual([stats.total, stats.total])
    expect(e64.embeds).toBe(chunkCount + memCount + 1) // +1 dimension probe

    // A SECOND reindex at the same dim must REUSE everything and re-embed nothing (the resumable
    // property: a converted store isn't re-embedded again).
    e64.embeds = 0
    const again = await b.reindex()
    expect(again.reembedded).toBe(0)
    expect(again.reused).toBe(chunkCount + memCount)
    expect(e64.embeds).toBe(1) // only the probe

    // retrieval still works after
    const res = await b.retrieval.searchWithFilters({ queries: ["alpha beta gamma"], userId: "u", orgId: "o", limit: 5 })
    expect(res.searchResults.length).toBeGreaterThan(0)
    b.store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("a store left MIXED-dim (interrupted migration) is finished by re-embedding only the remainder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chitta-mixed-"))
    const path = join(dir, "s.db")
    const e = new CountingDim(48)
    const ctx = buildEmbeddedContext({ path, embeddings: e })
    ctx.ingestor.registerUser("u", "o", "u@x.com", "editor")
    for (let i = 0; i < 5; i++) {
      await ctx.authorizedIngest("u", { recordId: `r${i}`, orgId: "o", recordName: `D${i}`, text: `content block ${i} with several words here`, permittedPrincipals: [] })
    }
    // Hand-corrupt HALF the chunks to a different dim to simulate an interrupted reindex.
    const ids = (ctx.store.db.query("SELECT point_id FROM chunks").all() as Array<{ point_id: string }>).map((r) => r.point_id)
    const bogus = new Uint8Array(96 * 4) // 96-dim, not the active 48
    for (let i = 0; i < ids.length; i += 2) ctx.store.db.query("UPDATE chunks SET embedding = ? WHERE point_id = ?").run(bogus, ids[i])
    expect(dimsInStore(ctx).size).toBeGreaterThan(1) // genuinely mixed now

    e.embeds = 0
    const stats = await ctx.reindex()
    // only the corrupted (96-dim) chunks needed re-embedding; the 48-dim ones were reused
    const corrupted = Math.ceil(ids.length / 2)
    expect(stats.reembedded).toBe(corrupted)
    expect(dimsInStore(ctx)).toEqual(new Set([48])) // consistent again
    ctx.store.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
