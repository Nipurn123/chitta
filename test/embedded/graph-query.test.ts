// Graph-query layer (ported from Graphify serve.py ergonomics) + source-keyed
// replace-on-reingest. ACL-filtered traversal over the entity graph.
import { test, expect, describe } from "bun:test"
import { SqliteStore } from "../../src/embedded/sqlite-store"
import { SqliteGraphProvider } from "../../src/embedded/sqlite-graph-provider"
import { GraphQueryService } from "../../src/embedded/graph-query"
import { Ingestor } from "../../src/embedded/ingest"
import { LocalHashEmbeddings } from "../../src/embedded/local-embeddings"
import type { KnowledgeExtractor, Extraction } from "../../src/embedded/extract"

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

// Build a small accessible graph: alice can see a doc whose facts wire up a chain
// of distinct ENTITY ids (never reusing the user id, which would collide in `nodes`).
async function fixture() {
  const store = new SqliteStore(":memory:")
  const emb = new LocalHashEmbeddings()
  const ing = new Ingestor(store, emb)
  ing.registerUser("alice", "org1", "a@x.com", "admin")
  // acme → globex → initech (partners) ; acme located_in nyc
  await new Ingestor(store, emb, typed([
    { from: "acme", to: "globex", type: "partners_with" },
    { from: "globex", to: "initech", type: "partners_with" },
    { from: "acme", to: "nyc", type: "located_in" },
  ])).ingest({ recordId: "r1", orgId: "org1", recordName: "graph", text: "x", permittedPrincipals: ["alice"] })
  const graph = new SqliteGraphProvider(store)
  return { store, graph, gq: new GraphQueryService(graph) }
}

describe("graph-query", () => {
  test("neighbors returns directly connected entities", async () => {
    const { gq } = await fixture()
    const r = await gq.neighbors("acme", "alice", "org1")
    expect(r).not.toBeNull()
    const labels = r!.neighbors.map((n) => n.label).sort()
    expect(labels).toEqual(["globex", "nyc"]) // partners_with (out) + located_in (out)
  })

  test("pathBetween finds the relation chain across hops", async () => {
    const { gq } = await fixture()
    const r = await gq.pathBetween("acme", "initech", "alice", "org1")
    expect(r.found).toBe(true)
    expect(r.hops).toBe(2) // acme→globex→initech
    expect(r.steps[0].from).toBe("acme")
    expect(r.steps[r.steps.length - 1].to).toBe("initech")
  })

  test("impactOf lists referencing records + connected entities", async () => {
    const { gq } = await fixture()
    const r = await gq.impactOf("globex", "alice", "org1")
    expect(r).not.toBeNull()
    expect(r!.records).toContain("graph")
    expect(r!.connectedEntities.map((c) => c.label).sort()).toEqual(["acme", "initech"])
  })

  test("central ranks hub entities by strength", async () => {
    const { gq } = await fixture()
    const hubs = await gq.central("alice", "org1")
    expect(hubs.length).toBeGreaterThan(0)
    expect(hubs[0].degree).toBeGreaterThanOrEqual(1)
  })

  test("communities cluster connected entities", async () => {
    const { gq } = await fixture()
    const cs = await gq.communities("alice", "org1")
    expect(cs.length).toBe(1) // acme/globex/initech/nyc are all one connected cluster
    expect(cs[0].members.sort()).toEqual(["acme", "globex", "initech", "nyc"])
  })

  test("toCypher exports MERGE statements for the accessible graph", async () => {
    const { gq } = await fixture()
    const cy = await gq.toCypher("alice", "org1")
    expect(cy).toContain("MERGE (n:ENTITY {id:'entity:acme'")
    expect(cy).toMatch(/MERGE \(a\)-\[:PARTNERS_WITH/)
  })

  test("ACL: communities/cypher are empty for a user with no access", async () => {
    const { store, gq } = await fixture()
    new Ingestor(store, new LocalHashEmbeddings()).registerUser("mallory", "org1", "m@x.com", "viewer")
    expect(await gq.communities("mallory", "org1")).toEqual([])
    expect(await gq.toCypher("mallory", "org1")).toBe("")
  })

  test("ACL: a different user with no access sees nothing", async () => {
    const { store, gq } = await fixture()
    new Ingestor(store, new LocalHashEmbeddings()).registerUser("mallory", "org1", "m@x.com", "viewer")
    const r = await gq.neighbors("acme", "mallory", "org1")
    expect(r).toBeNull() // acme isn't in mallory's accessible graph
  })
})

describe("source-keyed replace-on-reingest (Graphify build_merge)", () => {
  test("re-ingesting a record without a fact GARBAGE-COLLECTS that edge", async () => {
    const store = new SqliteStore(":memory:")
    const emb = new LocalHashEmbeddings()
    const doc = { recordId: "r1", orgId: "o", recordName: "d", text: "x" }
    // first ingest asserts two relations
    await new Ingestor(store, emb, typed([
      { from: "a", to: "b", type: "partners_with" },
      { from: "a", to: "c", type: "partners_with" },
    ])).ingest(doc)
    // re-ingest the SAME record now only asserting a→b (a→c was removed from the source)
    await new Ingestor(store, emb, typed([{ from: "a", to: "b", type: "partners_with" }])).ingest(doc)
    const live = store.db.query("SELECT dst FROM edges WHERE src='entity:a' AND label='partners_with'").all() as Array<{ dst: string }>
    expect(live.map((r) => r.dst)).toEqual(["entity:b"]) // a→c was GC'd, not orphaned
  })

  test("re-ingesting is idempotent - weight doesn't inflate", async () => {
    const store = new SqliteStore(":memory:")
    const emb = new LocalHashEmbeddings()
    const doc = { recordId: "r1", orgId: "o", recordName: "d", text: "x" }
    const ext = typed([{ from: "a", to: "b", type: "partners_with" }])
    await new Ingestor(store, emb, ext).ingest(doc)
    await new Ingestor(store, emb, ext).ingest(doc)
    await new Ingestor(store, emb, ext).ingest(doc)
    const row = store.db.query("SELECT weight FROM edges WHERE src='entity:a' AND dst='entity:b'").get() as { weight: number }
    expect(row.weight).toBe(1) // single source → weight stays 1 across re-ingests
  })

  test("a fact asserted by TWO records survives when only one re-ingests without it", async () => {
    const store = new SqliteStore(":memory:")
    const emb = new LocalHashEmbeddings()
    await new Ingestor(store, emb, typed([{ from: "a", to: "b", type: "partners_with" }])).ingest({ recordId: "r1", orgId: "o", recordName: "d1", text: "x" })
    await new Ingestor(store, emb, typed([{ from: "a", to: "b", type: "partners_with" }])).ingest({ recordId: "r2", orgId: "o", recordName: "d2", text: "x" })
    // r1 re-ingested without the fact → r2 still asserts it
    await new Ingestor(store, emb, typed([])).ingest({ recordId: "r1", orgId: "o", recordName: "d1", text: "x" })
    const row = store.db.query("SELECT weight, provenance FROM edges WHERE src='entity:a' AND dst='entity:b'").get() as { weight: number; provenance: string } | undefined
    expect(row).toBeDefined()
    expect(row!.weight).toBe(1) // down from 2 to 1 (only r2 remains)
    expect(JSON.parse(row!.provenance)).toEqual(["r2"])
  })
})
