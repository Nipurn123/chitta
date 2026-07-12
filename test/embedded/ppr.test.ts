// Personalized PageRank multi-hop walk (HippoRAG-style) over the ACL-scoped graph.
import { test, expect, describe } from "bun:test"
import { SqliteStore } from "../../src/embedded/sqlite-store"
import { SqliteGraphProvider } from "../../src/embedded/sqlite-graph-provider"
import { GraphQueryService } from "../../src/embedded/graph-query"
import { Ingestor } from "../../src/embedded/ingest"
import { LocalHashEmbeddings } from "../../src/embedded/local-embeddings"
import type { KnowledgeExtractor, Extraction } from "../../src/embedded/extract"
import { buildEmbeddedContext, type EmbeddedContext } from "../../src/embedded/index"
import { pprRecordScores, pprDefaults } from "../../src/embedded/graph/ppr"
import type { SqlAccess } from "../../src/embedded/graph/sql-access"

const typed = (rels: Array<{ from: string; to: string; type: string }>): KnowledgeExtractor => ({
  async extract(): Promise<Extraction> {
    const ids = new Set<string>()
    for (const r of rels) {
      ids.add(r.from)
      ids.add(r.to)
    }
    return { entities: [...ids].map((id) => ({ id, label: id, type: "ENTITY" })), relations: rels }
  },
})

describe("Personalized PageRank walk", () => {
  test("ranks multi-hop-reachable entities, seeds excluded", async () => {
    const store = new SqliteStore(":memory:")
    const ing = new Ingestor(store, new LocalHashEmbeddings())
    ing.registerUser("u", "o", "u@x.com", "admin")
    // A is a hub: A-B, A-C, A-D; B-E (E is 2 hops from A). F is isolated from A.
    await new Ingestor(store, new LocalHashEmbeddings(), typed([
      { from: "A", to: "B", type: "rel" },
      { from: "A", to: "C", type: "rel" },
      { from: "A", to: "D", type: "rel" },
      { from: "B", to: "E", type: "rel" },
      { from: "F", to: "G", type: "rel" },
    ])).ingest({ recordId: "r1", orgId: "o", recordName: "g", text: "x", permittedPrincipals: ["u"] })

    const gq = new GraphQueryService(new SqliteGraphProvider(store))
    const ranked = await gq.walk(["A"], "u", "o")
    const labels = ranked.map((r) => r.label)
    expect(labels).not.toContain("A") // seed excluded
    // direct neighbors (B,C,D) outrank the 2-hop node E, which outranks the disconnected F/G
    expect(labels.indexOf("B")).toBeLessThan(labels.indexOf("E"))
    expect(labels).not.toContain("F") // F/G unreachable from A → score 0 → excluded
    expect(labels).not.toContain("G")
  })

  test("ACL: a user with no access gets nothing", async () => {
    const store = new SqliteStore(":memory:")
    new Ingestor(store, new LocalHashEmbeddings()).registerUser("mallory", "o", "m@x.com", "viewer")
    const gq = new GraphQueryService(new SqliteGraphProvider(store))
    expect(await gq.walk(["A"], "mallory", "o")).toEqual([])
  })
})

// ── PPR RETRIEVAL (graph/ppr.ts + the CONTEXT_GRAPH_PPR leg of hybrid search) ──
// The walk above ranks ENTITIES for graph queries; the engine below ranks RECORDS as a
// retrieval signal. Tests use caller-PROVIDED entities/relations (no extractor), so the
// graph shape - and therefore every reachability claim - is exact, not heuristic.

// Raw-SQL seam over a store, same shape the provider hands its graph modules.
const sqlOf = (store: SqliteStore): SqlAccess => ({
  rows: <T>(s: string, p: unknown[]) => store.db.query(s).all(...(p as any[])) as T[],
  ph: (n: number) => Array.from({ length: n }, () => "?").join(","),
})

// Canonical entity id by label (tests name entities by their exact ingested label).
const entIdOf = (ctx: EmbeddedContext, label: string): string => {
  const row = ctx.store.db.query("SELECT id FROM nodes WHERE coll = 'entities' AND json_extract(data,'$.label') = ?").get(label) as { id: string } | null
  if (!row) throw new Error(`entity not found: ${label}`)
  return row.id
}

// The user's accessible RECORD-id set (what pprRecordScores gates every edge on).
const accOf = async (ctx: EmbeddedContext, userId: string): Promise<ReadonlySet<string>> =>
  new Set(Object.values(await ctx.graph.getAccessibleVirtualRecordIds({ userId, orgId: "o" })) as string[])

type Doc = { recordId: string; text: string; entities?: Array<{ name: string; type?: string }>; relations?: Array<{ from: string; to: string; type: string }>; principals?: string[] }
const ingestAll = async (ctx: EmbeddedContext, asUser: string, docs: Doc[]) => {
  for (const d of docs)
    await ctx.authorizedIngest(asUser, {
      recordId: d.recordId, orgId: "o", recordName: d.recordId, text: d.text,
      permittedPrincipals: d.principals ?? [asUser], entities: d.entities, relations: d.relations,
    })
}

describe("PPR record retrieval (multi-hop, ACL-fail-closed, hub-robust)", () => {
  test("(a) 2-hop chain: A mentions X, X-relates-Y, Y mentioned by B - seeding X surfaces B", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o", "e", "admin")
    await ingestAll(ctx, "u", [
      { recordId: "A", text: "Project Zephyr uses the Kestrel pipeline.",
        entities: [{ name: "Project Zephyr", type: "PROJECT" }, { name: "Kestrel pipeline", type: "TECH" }],
        relations: [{ from: "Project Zephyr", to: "Kestrel pipeline", type: "uses" }] },
      { recordId: "B", text: "The Kestrel pipeline is maintained by Dana Cruz.",
        entities: [{ name: "Kestrel pipeline", type: "TECH" }, { name: "Dana Cruz", type: "PERSON" }],
        relations: [{ from: "Kestrel pipeline", to: "Dana Cruz", type: "maintained_by" }] },
    ])
    const ranked = pprRecordScores(sqlOf(ctx.store), [entIdOf(ctx, "Project Zephyr")], await accOf(ctx, "u"))
    const ids = ranked.map((r) => r.recordId)
    expect(ids).toContain("B") // reached across the entity bridge, not by text similarity
    expect(ranked.find((r) => r.recordId === "B")!.score).toBeGreaterThan(0)
  })

  // A genuine chain the 1-hop expansion is STRUCTURALLY blind to. Seeding starts from the
  // records that mention the query entity X (R1 + RB1), whose entity pool is {X, E2}; one
  // relation hop adds E3 - so records mentioning ONLY E4 (the target) sit one entity past
  // the old horizon. PPR walks the full chain X→E2→E3→E4 and gets there.
  const chainDocs: Doc[] = [
    { recordId: "R1", text: "Project Zephyr is our flagship initiative.",
      entities: [{ name: "Project Zephyr", type: "PROJECT" }] },
    { recordId: "RB1", text: "Project Zephyr uses the Kestrel pipeline.",
      entities: [{ name: "Project Zephyr", type: "PROJECT" }, { name: "Kestrel pipeline", type: "TECH" }],
      relations: [{ from: "Project Zephyr", to: "Kestrel pipeline", type: "uses" }] },
    { recordId: "RB2", text: "the kestrel pipeline feeds the neptune cluster nightly",
      entities: [{ name: "Kestrel pipeline", type: "TECH" }, { name: "Neptune cluster", type: "TECH" }],
      relations: [{ from: "Kestrel pipeline", to: "Neptune cluster", type: "feeds" }] },
    { recordId: "RB3", text: "the neptune cluster reports into the aurora control plane",
      entities: [{ name: "Neptune cluster", type: "TECH" }, { name: "Aurora plane", type: "TECH" }],
      relations: [{ from: "Neptune cluster", to: "Aurora plane", type: "reports_to" }] },
    { recordId: "R3", text: "the aurora control plane runs from the reykjavik datacenter",
      entities: [{ name: "Aurora plane", type: "TECH" }, { name: "Reykjavik datacenter", type: "PLACE" }],
      relations: [{ from: "Aurora plane", to: "Reykjavik datacenter", type: "located_in" }] },
  ]

  test("(b) 3-hop chain: PPR reaches the record the 1-hop expansion cannot", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o", "e", "admin")
    await ingestAll(ctx, "u", chainDocs)
    const acc = await accOf(ctx, "u")
    // the OLD horizon, seeded exactly like retrieval seeds it (records mentioning X):
    const oneHop = ctx.graph.getRelatedRecordIds(["R1", "RB1"], acc, 10)
    expect(oneHop).toContain("RB2") // one hop works...
    expect(oneHop).not.toContain("R3") // ...and provably stops short of the target
    // PPR from the same query entity walks the whole chain:
    const ids = pprRecordScores(sqlOf(ctx.store), [entIdOf(ctx, "Project Zephyr")], acc).map((r) => r.recordId)
    expect(ids).toContain("R3")
  })

  test("(b) end-to-end: flag ON surfaces the 3-hop record, flag OFF does not", async () => {
    // 12 fillers overlap the query only in embedding space (char n-grams: "projects"~
    // "project", "zephyrus"~"zephyr") but share NO literal FTS token with it - they
    // deterministically crowd the target out of the dense/keyword pool, so the ONLY way
    // R3 can surface is through a graph signal. Lowercase ⇒ no entities ⇒ no graph legs.
    const fillers: Doc[] = Array.from({ length: 12 }, (_, i) => ({
      recordId: `f${i}`, text: `zephyrus projects briefing memo ${i} covering quarterly milestones`,
    }))
    const run = async (query: string): Promise<string[]> => {
      const ctx = buildEmbeddedContext({ path: ":memory:" })
      ctx.ingestor.registerUser("u", "o", "e", "admin")
      await ingestAll(ctx, "u", [...chainDocs, ...fillers])
      const res = await ctx.searchWithGraph(query, "u", "o", undefined, 6)
      return res.searchResults.map((r) => (r.metadata as { recordId?: string }).recordId ?? "")
    }
    process.env.CONTEXT_RETRIEVE_LIMIT = "10"
    try {
      process.env.CONTEXT_GRAPH_PPR = "1"
      expect(await run("tell me about Project Zephyr")).toContain("R3")
      process.env.CONTEXT_GRAPH_PPR = "0"
      expect(await run("tell me about Project Zephyr")).not.toContain("R3")
    } finally {
      delete process.env.CONTEXT_GRAPH_PPR
      delete process.env.CONTEXT_RETRIEVE_LIMIT
    }
  })

  test("(c) ACL: a bridge edge asserted only by an inaccessible record must not let evidence flow", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o", "u@x", "member")
    ctx.ingestor.registerUser("mallory", "o", "m@x", "member")
    ctx.ingestor.registerUser("boss", "o", "b@x", "member")
    await ingestAll(ctx, "u", [
      { recordId: "A", text: "The Falcon initiative kicked off in June.",
        entities: [{ name: "Falcon initiative", type: "PROJECT" }], principals: ["u", "boss"] },
      { recordId: "B", text: "The Osprey database stores nightly backups.",
        entities: [{ name: "Osprey database", type: "TECH" }], principals: ["u", "boss"] },
    ])
    // The ONLY Falcon→Osprey bridge lives in mallory's private record. Both endpoints are
    // entities u can see - endpoint visibility must NOT be enough (fail-closed provenance).
    await ingestAll(ctx, "mallory", [
      { recordId: "C", text: "The Falcon initiative secretly depends on the Osprey database.",
        entities: [{ name: "Falcon initiative", type: "PROJECT" }, { name: "Osprey database", type: "TECH" }],
        relations: [{ from: "Falcon initiative", to: "Osprey database", type: "depends_on" }],
        principals: ["mallory", "boss"] },
    ])
    const sql = sqlOf(ctx.store)
    const falcon = entIdOf(ctx, "Falcon initiative")
    // u: the bridge is invisible ⇒ no mass may cross it ⇒ nothing beyond the seed is
    // reachable (and seed-mention records are the dense/sparse legs' job, not PPR's).
    const forU = pprRecordScores(sql, [falcon], await accOf(ctx, "u")).map((r) => r.recordId)
    expect(forU).not.toContain("B")
    expect(forU).not.toContain("C")
    // boss sees the asserting record ⇒ the same edge DOES flow (proves the gate is the
    // provenance check, not some accident of graph shape).
    expect(pprRecordScores(sql, [falcon], await accOf(ctx, "boss")).map((r) => r.recordId)).toContain("B")
    // end-to-end: nothing of C's content can ever surface for u through any leg.
    const res = await ctx.searchWithGraph("what depends on the Falcon initiative", "u", "o", undefined, 10)
    expect(res.searchResults.some((r) => (r.metadata as { recordId?: string }).recordId === "C")).toBe(false)
    expect(res.searchResults.some((r) => r.content.includes("secretly"))).toBe(false)
  })

  test("(d) hub robustness: a 40-record hub entity does not dominate PPR mass", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o", "e", "admin")
    // Anchor: seed entity X bridges to a hub (Acme, 41 mentions) AND a specific 2-hop
    // path (Lyra lab → record B). The hub receives comparable walk mass, but splitting
    // it across 41 records must leave each hub record far below the specific target.
    await ingestAll(ctx, "u", [
      { recordId: "A", text: "The Nova probe is operated by Acme Corp from the Lyra lab.",
        entities: [{ name: "Nova probe", type: "TECH" }, { name: "Acme Corp", type: "ORG" }, { name: "Lyra lab", type: "PLACE" }],
        relations: [
          { from: "Nova probe", to: "Acme Corp", type: "operated_by" },
          { from: "Nova probe", to: "Lyra lab", type: "built_at" },
        ] },
      { recordId: "B", text: "the lyra lab sits on a hill above prague",
        entities: [{ name: "Lyra lab", type: "PLACE" }] },
      ...Array.from({ length: 40 }, (_, i): Doc => ({
        recordId: `h${i}`, text: `person ${i} record`,
        entities: [{ name: `Person ${i}`, type: "PERSON" }, { name: "Acme Corp", type: "ORG" }],
        relations: [{ from: `Person ${i}`, to: "Acme Corp", type: "works_at" }],
      })),
    ])
    const sql = sqlOf(ctx.store)
    const acc = await accOf(ctx, "u")
    const ranked = pprRecordScores(sql, [entIdOf(ctx, "Nova probe")], acc)
    const scoreOf = (id: string) => ranked.find((r) => r.recordId === id)?.score ?? 0
    // the specific 2-hop target is found, ranks at the top, and beats EVERY hub record
    expect(scoreOf("B")).toBeGreaterThan(0)
    expect(ranked.slice(0, 3).map((r) => r.recordId)).toContain("B")
    for (let i = 0; i < 40; i++) expect(scoreOf(`h${i}`)).toBeLessThan(scoreOf("B"))
    // with a stricter hub threshold the hub is excluded outright: no hub record at all,
    // the multi-hop target still found (the bounded hop's CONTEXT_GRAPH_HUB semantics)
    const strict = pprRecordScores(sql, [entIdOf(ctx, "Nova probe")], acc, { ...pprDefaults(), hub: 10 })
    expect(strict.map((r) => r.recordId)).toContain("B")
    expect(strict.some((r) => r.recordId.startsWith("h"))).toBe(false)
  })

  test("fail-closed plumbing: no seeds or no accessible records yields nothing", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o", "e", "admin")
    await ingestAll(ctx, "u", [{ recordId: "A", text: "x", entities: [{ name: "Solo entity" }] }])
    const sql = sqlOf(ctx.store)
    expect(pprRecordScores(sql, [], await accOf(ctx, "u"))).toEqual([])
    expect(pprRecordScores(sql, [entIdOf(ctx, "Solo entity")], new Set())).toEqual([])
  })
})
