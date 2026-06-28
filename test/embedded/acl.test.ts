// Access control over the GRAPH layer: an edge (relationship) must only surface to a
// user who can access a record that ASSERTED it - endpoint visibility is NOT enough.
import { test, expect, describe } from "bun:test"
import { SqliteStore } from "../../src/embedded/sqlite-store"
import { SqliteGraphProvider } from "../../src/embedded/sqlite-graph-provider"
import { GraphQueryService } from "../../src/embedded/graph-query"
import { Ingestor } from "../../src/embedded/ingest"
import { LocalHashEmbeddings } from "../../src/embedded/local-embeddings"
import type { KnowledgeExtractor, Extraction } from "../../src/embedded/extract"

const typed = (e: any[], r: any[]): KnowledgeExtractor => ({ async extract(): Promise<Extraction> { return { entities: e, relations: r } } })

async function fixture() {
  const store = new SqliteStore(":memory:")
  const base = new Ingestor(store, new LocalHashEmbeddings())
  base.registerUser("alice", "org", "a", "editor")
  base.registerUser("bob", "org", "b", "editor")
  // alice: a PUBLIC record that merely MENTIONS Google and HSBC (no relationship)
  await new Ingestor(store, new LocalHashEmbeddings(), typed([{ id: "google", label: "Google", type: "ORG" }, { id: "hsbc", label: "HSBC", type: "ORG" }], [])).ingest({ recordId: "alice-rec", orgId: "org", recordName: "public", text: "x", permittedPrincipals: ["alice"] })
  // bob: a PRIVATE record asserting the secret relationship between those same entities
  await new Ingestor(store, new LocalHashEmbeddings(), typed([{ id: "google", label: "Google", type: "ORG" }, { id: "hsbc", label: "HSBC", type: "ORG" }], [{ from: "google", to: "hsbc", type: "secretly_partners_with" }])).ingest({ recordId: "bob-rec", orgId: "org", recordName: "private", text: "x", permittedPrincipals: ["bob"] })
  const graph = new SqliteGraphProvider(store)
  return { store, graph, gq: new GraphQueryService(graph) }
}

const accessibleOf = async (graph: SqliteGraphProvider, user: string) =>
  [...new Set(Object.values(await graph.getAccessibleVirtualRecordIds({ userId: user, orgId: "org" })))]

describe("graph-layer ACL - per-edge provenance filtering", () => {
  test("a private relationship between two visible entities does NOT leak", async () => {
    const { graph } = await fixture()
    const kg = graph.getKnowledgeGraph(await accessibleOf(graph, "alice"))
    expect(kg.relations.some((r) => r.type === "secretly_partners_with")).toBe(false)
  })

  test("the owner still sees their own edge", async () => {
    const { graph } = await fixture()
    const kg = graph.getKnowledgeGraph(await accessibleOf(graph, "bob"))
    expect(kg.relations.some((r) => r.type === "secretly_partners_with")).toBe(true)
  })

  test("graph-query (neighbors/walk) inherits the edge ACL", async () => {
    const { gq } = await fixture()
    const aliceNb = await gq.neighbors("Google", "alice", "org")
    expect(aliceNb?.neighbors.some((n) => n.relation === "secretly_partners_with")).toBeFalsy()
    const bobNb = await gq.neighbors("Google", "bob", "org")
    expect(bobNb?.neighbors.some((n) => n.relation === "secretly_partners_with")).toBe(true)
    // PageRank walk for alice must not reach HSBC via the private edge
    const aliceWalk = await gq.walk(["Google"], "alice", "org")
    expect(aliceWalk.some((x) => x.label === "HSBC")).toBe(false)
  })
})
