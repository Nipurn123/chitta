// Personalized PageRank multi-hop walk (HippoRAG-style) over the ACL-scoped graph.
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
