// Bi-temporal + merge-on-upsert edges - the advanced graph layer ported from
// Graphiti (invalidate-never-delete) and LightRAG (merge-on-upsert + weight).
import { test, expect, describe } from "bun:test"
import { SqliteStore } from "../../src/embedded/sqlite-store"
import { Ingestor } from "../../src/embedded/ingest"
import { LocalHashEmbeddings } from "../../src/embedded/local-embeddings"
import type { KnowledgeExtractor, Extraction } from "../../src/embedded/extract"

describe("merge-on-upsert edges (LightRAG)", () => {
  test("re-asserting an edge accumulates weight instead of duplicating", () => {
    const s = new SqliteStore(":memory:")
    s.addEdge("google", "hsbc", "partners_with")
    s.addEdge("google", "hsbc", "partners_with")
    s.addEdge("google", "hsbc", "partners_with")
    const rows = s.db.query("SELECT weight FROM edges WHERE src='google' AND dst='hsbc' AND label='partners_with'").all() as Array<{ weight: number }>
    expect(rows.length).toBe(1) // one row, not three
    expect(rows[0].weight).toBe(3) // frequency ≈ confidence
    s.close()
  })

  test("provenance unions the source records that asserted the edge", () => {
    const s = new SqliteStore(":memory:")
    s.addEdge("a", "b", "relates_to", { recordId: "rec1" })
    s.addEdge("a", "b", "relates_to", { recordId: "rec2" })
    s.addEdge("a", "b", "relates_to", { recordId: "rec1" }) // dup record → no growth
    const row = s.db.query("SELECT provenance FROM edges WHERE src='a' AND dst='b'").get() as { provenance: string }
    expect(new Set(JSON.parse(row.provenance))).toEqual(new Set(["rec1", "rec2"]))
    s.close()
  })

  test("created_at is stamped and stable across re-assertion", () => {
    const s = new SqliteStore(":memory:")
    s.addEdge("x", "y", "rel")
    const t1 = (s.db.query("SELECT created_at FROM edges WHERE src='x'").get() as { created_at: number }).created_at
    expect(t1).toBeGreaterThan(0)
    s.close()
  })
})

describe("non-destructive supersession (Graphiti bi-temporal)", () => {
  test("a newer functional fact invalidates the old one but keeps it in history", () => {
    const s = new SqliteStore(":memory:")
    // user lived in SF, then moved to NYC - lives_in is single-valued (functional)
    s.addEdge("user", "sf", "lives_in")
    s.addEdge("user", "nyc", "lives_in")
    const closed = s.supersedeEdge("user", "lives_in", "nyc")
    expect(closed).toBe(1) // the SF edge was closed

    // SF edge still exists (history preserved) but is no longer LIVE
    const sf = s.db.query("SELECT invalid_at, expired_at FROM edges WHERE src='user' AND dst='sf'").get() as {
      invalid_at: number | null
      expired_at: number | null
    }
    expect(sf.invalid_at).not.toBeNull()
    expect(sf.expired_at).not.toBeNull()

    // only NYC is live
    const live = s.db.query("SELECT dst FROM edges WHERE src='user' AND label='lives_in' AND expired_at IS NULL").all() as Array<{ dst: string }>
    expect(live.map((r) => r.dst)).toEqual(["nyc"])
    s.close()
  })

  test("re-asserting a superseded edge revives it (clears expiry)", () => {
    const s = new SqliteStore(":memory:")
    s.addEdge("user", "sf", "lives_in")
    s.supersedeEdge("user", "lives_in", "nyc") // close SF (no NYC edge yet, just closes SF)
    expect((s.db.query("SELECT expired_at FROM edges WHERE dst='sf'").get() as any).expired_at).not.toBeNull()
    s.addEdge("user", "sf", "lives_in") // moved back
    expect((s.db.query("SELECT expired_at FROM edges WHERE dst='sf'").get() as any).expired_at).toBeNull()
    s.close()
  })
})

describe("ingest wires supersession for functional typed relations", () => {
  // A stub typed extractor (what the LLM extractor produces): subject -predicate→ object.
  const typed = (rels: Array<{ from: string; to: string; type: string }>): KnowledgeExtractor => ({
    async extract(): Promise<Extraction> {
      const ids = new Set<string>()
      for (const r of rels) {
        ids.add(r.from)
        ids.add(r.to)
      }
      return {
        entities: [...ids].map((id) => ({ id, label: id, type: "ENTITY" })),
        relations: rels,
      }
    },
  })

  test("ingesting 'alex works_at acme' then 'alex works_at globex' leaves only globex live", async () => {
    const store = new SqliteStore(":memory:")
    const emb = new LocalHashEmbeddings()
    // first job
    await new Ingestor(store, emb, typed([{ from: "alex", to: "acme", type: "works_at" }])).ingest({
      recordId: "r1", orgId: "o", recordName: "job1", text: "Alex works at Acme",
    })
    // later job - functional relation, newer value
    await new Ingestor(store, emb, typed([{ from: "alex", to: "globex", type: "works_at" }])).ingest({
      recordId: "r2", orgId: "o", recordName: "job2", text: "Alex works at Globex",
    })
    const live = store.db.query("SELECT dst FROM edges WHERE src='entity:alex' AND label='works_at' AND expired_at IS NULL").all() as Array<{ dst: string }>
    expect(live.map((r) => r.dst)).toEqual(["entity:globex"])
    // but acme is still in history (not deleted)
    const all = store.db.query("SELECT COUNT(*) c FROM edges WHERE src='entity:alex' AND label='works_at'").get() as { c: number }
    expect(all.c).toBe(2)
    store.close()
  })

  test("non-functional 'partners_with' accumulates both (no supersession)", async () => {
    const store = new SqliteStore(":memory:")
    const emb = new LocalHashEmbeddings()
    await new Ingestor(store, emb, typed([{ from: "google", to: "hsbc", type: "partners_with" }])).ingest({
      recordId: "r1", orgId: "o", recordName: "d1", text: "Google partners with HSBC",
    })
    await new Ingestor(store, emb, typed([{ from: "google", to: "anthropic", type: "partners_with" }])).ingest({
      recordId: "r2", orgId: "o", recordName: "d2", text: "Google partners with Anthropic",
    })
    const live = store.db.query("SELECT dst FROM edges WHERE src='entity:google' AND label='partners_with' AND expired_at IS NULL ORDER BY dst").all() as Array<{ dst: string }>
    expect(live.map((r) => r.dst)).toEqual(["entity:anthropic", "entity:hsbc"]) // both live - multi-valued
    store.close()
  })
})
