// Memory decay / salience: among equally-relevant memories, the FRESH / often-accessed
// one ranks above a STALE one - without ever deleting the stale one.
import { test, expect, describe } from "bun:test"
import { buildEmbeddedContext } from "../../src/embedded/index"
import type { FusedResult } from "../../src/embedded/retrieval/fuse"

async function two() {
  process.env.CONTEXT_EMBEDDINGS = "hash"
  process.env.CONTEXT_DECAY = "1"
  const ctx = buildEmbeddedContext({ path: ":memory:" })
  ctx.ingestor.registerUser("u", "o", "u@x.com", "admin")
  // two records with IDENTICAL relevant content → decay is the tiebreaker
  for (const id of ["rec-old", "rec-new"])
    await ctx.authorizedIngest("u", { recordId: id, orgId: "o", recordName: id, text: "alpha beta gamma signal payload", permittedPrincipals: ["u"] })
  return ctx
}

describe("memory decay / salience re-ranking", () => {
  test("a stale memory ranks below an equally-relevant fresh one (but is NOT deleted)", async () => {
    const ctx = await two()
    // age rec-old by 300 days (set lastAccessedAt far in the past)
    const old = Date.now() - 300 * 86_400_000
    ctx.store.db.query("UPDATE nodes SET data = json_set(data,'$.lastAccessedAt',?) WHERE id='rec-old'").run(old)
    const out = await ctx.searchWithGraph("alpha beta gamma", "u", "o")
    const ids = out.searchResults.map((r) => r.metadata.recordId)
    expect(ids).toContain("rec-new")
    expect(ids).toContain("rec-old") // stale, still retrievable - NOT deleted
    expect(ids.indexOf("rec-new")).toBeLessThan(ids.indexOf("rec-old")) // fresh ranks higher
  })

  test("recency is in whole days: records stored minutes apart keep exact fused ties", async () => {
    const ctx = await two()
    const { decayConfig, decayStage } = await import("../../src/embedded/retrieval/decay-stage")
    const at = (id: string, ms: number) => ctx.store.db.query("UPDATE nodes SET data = json_set(data,'$.lastAccessedAt',?) WHERE id=?").run(ms, id)
    const now = Date.now()
    at("rec-old", now - 40 * 60_000) // 40 minutes earlier - same day
    at("rec-new", now)
    const mk = (id: string) => ({ content: id, metadata: { recordId: id }, rrf: 1 / 65, legs: new Set(["vector"]) }) as unknown as FusedResult
    const merged = [mk("rec-old"), mk("rec-new")] // tied; the fused order puts rec-old first
    decayStage(ctx.store, merged, "u", decayConfig())
    expect(merged[0].rrf).toBe(merged[1].rrf) // still an exact tie...
    expect(merged.map((m) => m.metadata.recordId)).toEqual(["rec-old", "rec-new"]) // ...so the fused order stands
  })

  test("write-time importance doesn't move the ranking by default (CONTEXT_IMPORTANCE_W=0)", async () => {
    const ctx = await two()
    ctx.store.db.query("UPDATE nodes SET data = json_set(data,'$.importance',3) WHERE id='rec-old'").run()
    const { decayConfig, decayStage } = await import("../../src/embedded/retrieval/decay-stage")
    const mk = () => [{ content: "x", metadata: { recordId: "rec-old" }, rrf: 1, legs: new Set(["vector"]) }] as unknown as FusedResult[]
    const base = { ...decayConfig(), personalBoost: 1 }
    const off = mk()
    decayStage(ctx.store, off, "u", base)
    expect(off[0].rrf).toBeCloseTo(1, 5) // cue-word importance no longer outranks relevance
    const on = mk()
    decayStage(ctx.store, on, "u", { ...base, importanceW: 1 }) // the old behaviour, opt-in
    expect(on[0].rrf).toBeCloseTo(3, 5)
  })

  const uses = (ctx: Awaited<ReturnType<typeof two>>, id: string) =>
    (ctx.store.db.query("SELECT COALESCE(json_extract(data,'$.accessCount'),0) c FROM nodes WHERE id=?").get(id) as { c: number }).c

  test("retrieval is read-only - a search does not count as a use", async () => {
    // Counting every result as used made each query boost what it returned and bias the next
    // (-7.9 points all-gold@10 on pooled LongMemEval).
    const ctx = await two()
    await ctx.searchWithGraph("alpha beta gamma", "u", "o")
    await ctx.searchWithGraph("alpha beta gamma", "u", "o")
    expect(uses(ctx, "rec-new")).toBe(0)
    expect(uses(ctx, "rec-old")).toBe(0)
  })

  test("markUsed records a real use, only for records the user can see", async () => {
    const ctx = await two()
    ctx.ingestor.registerUser("eve", "o", "eve@x.com", "admin")
    await ctx.authorizedIngest("eve", { recordId: "rec-private", orgId: "o", recordName: "p", text: "alpha beta gamma eve only", permittedPrincipals: ["eve"] })
    await ctx.markUsed("u", "o", ["rec-new", "rec-new", "rec-private"])
    expect(uses(ctx, "rec-new")).toBe(1) // deduplicated within one call
    expect(uses(ctx, "rec-private")).toBe(0) // outside u's ACL slice - not counted
  })

  test("the access boost is capped - 50 uses lift a record no more than the cap", async () => {
    const ctx = await two()
    for (let i = 0; i < 50; i++) await ctx.markUsed("u", "o", ["rec-old"])
    const { decayConfig, decayStage } = await import("../../src/embedded/retrieval/decay-stage")
    const cfg = { ...decayConfig(), personalBoost: 1 } // isolate the access term
    const merged = [{ content: "x", metadata: { recordId: "rec-old" }, rrf: 1, legs: new Set(["vector"]) }] as unknown as FusedResult[]
    decayStage(ctx.store, merged, "u", cfg)
    // uncapped this would be 1 + 0.15·ln(51) ≈ 1.59; just used ⇒ recency factor 1
    expect(merged[0].rrf).toBeCloseTo(cfg.accessCap, 5)
  })
})
