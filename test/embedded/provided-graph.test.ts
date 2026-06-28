// Caller-supplied typed graph: the frontier model passes the entities + relations it
// already understood to context_ingest, and they're stored as precise typed triples -
// no built-in extractor, no separate LLM endpoint.
import { test, expect, describe } from "bun:test"
import { SqliteStore } from "../../src/embedded/sqlite-store"
import { SqliteGraphProvider } from "../../src/embedded/sqlite-graph-provider"
import { GraphQueryService } from "../../src/embedded/graph-query"
import { Ingestor } from "../../src/embedded/ingest"
import { LocalHashEmbeddings } from "../../src/embedded/local-embeddings"

function ctx() {
  const store = new SqliteStore(":memory:")
  const ing = new Ingestor(store, new LocalHashEmbeddings())
  ing.registerUser("u", "o", "u@x.com", "admin")
  return { store, ing, gq: new GraphQueryService(new SqliteGraphProvider(store)) }
}

describe("caller-supplied typed graph", () => {
  test("stores typed triples directly (precise predicate, not relates_to)", async () => {
    const { store, ing } = ctx()
    await ing.ingest({
      recordId: "r1",
      orgId: "o",
      recordName: "news",
      text: "Aviva deploys AI to stop £230M in insurance fraud.",
      permittedPrincipals: ["u"],
      entities: [
        { name: "Aviva", type: "ORG" },
        { name: "AI fraud detection", type: "CONCEPT" },
      ],
      relations: [{ from: "Aviva", to: "AI fraud detection", type: "deploys", confidence: 0.95 }],
    })
    const edge = store.db.query("SELECT label, confidence FROM edges WHERE src='entity:aviva' AND dst='entity:ai-fraud-detection'").get() as
      | { label: string; confidence: number }
      | undefined
    expect(edge?.label).toBe("deploys") // typed predicate, not "relates_to"
    expect(edge?.confidence).toBe(0.95)
  })

  test("relational graph query resolves the exact typed relationship", async () => {
    const { ing, gq } = ctx()
    await ing.ingest({
      recordId: "r1",
      orgId: "o",
      recordName: "deals",
      text: "Google partnered with HSBC; SAP partnered with Google Cloud.",
      permittedPrincipals: ["u"],
      entities: [{ name: "Google" }, { name: "HSBC" }, { name: "SAP" }, { name: "Google Cloud" }],
      relations: [
        { from: "Google", to: "HSBC", type: "partners_with" },
        { from: "SAP", to: "Google Cloud", type: "partners_with" },
      ],
    })
    const nb = await gq.neighbors("Google", "u", "o")
    expect(nb!.neighbors.find((n) => n.label === "HSBC")?.relation).toBe("partners_with")
  })

  test("functional relation supersedes across re-ingest (typed path)", async () => {
    const { store, ing } = ctx()
    await ing.ingest({
      recordId: "r1", orgId: "o", recordName: "bio", text: "x", permittedPrincipals: ["u"],
      entities: [{ name: "Alex" }, { name: "Acme" }],
      relations: [{ from: "Alex", to: "Acme", type: "works_at" }],
    })
    await ing.ingest({
      recordId: "r2", orgId: "o", recordName: "bio2", text: "x", permittedPrincipals: ["u"],
      entities: [{ name: "Alex" }, { name: "Globex" }],
      relations: [{ from: "Alex", to: "Globex", type: "works_at" }],
    })
    const live = store.db.query("SELECT dst FROM edges WHERE src='entity:alex' AND label='works_at' AND expired_at IS NULL").all() as Array<{ dst: string }>
    expect(live.map((r) => r.dst)).toEqual(["entity:globex"]) // newer functional fact wins; acme kept in history
  })

  test("graph queries prefer the typed predicate over generic relates_to", async () => {
    const { store, ing, gq } = ctx()
    // SAP-Google Cloud has BOTH a noisy relates_to (co-occurrence) and a typed edge.
    store.addNode("sap", "entities", { label: "SAP", type: "ORG" })
    store.addNode("google-cloud", "entities", { label: "Google Cloud", type: "ORG" })
    store.addEdge("r0", "sap", "mentions", { recordId: "r0" })
    store.addEdge("r0", "google-cloud", "mentions", { recordId: "r0" })
    store.addNode("r0", "records", { virtualRecordId: "r0", orgId: "o", recordName: "n", indexingStatus: "COMPLETED" })
    store.addEdge("u", "r0", "permissions")
    store.addEdge("sap", "google-cloud", "relates_to", { recordId: "r0" })
    await ing.ingest({
      recordId: "r1", orgId: "o", recordName: "deal", text: "x", permittedPrincipals: ["u"],
      entities: [{ name: "SAP" }, { name: "Google Cloud" }],
      relations: [{ from: "SAP", to: "Google Cloud", type: "partners_with" }],
    })
    const nb = await gq.neighbors("SAP", "u", "o")
    expect(nb!.neighbors[0].relation).toBe("partners_with") // typed leads, not relates_to
  })

  test("falls back to the built-in extractor when no graph is supplied", async () => {
    const { store, ing } = ctx()
    await ing.ingest({
      recordId: "r1", orgId: "o", recordName: "note.txt",
      text: "100X Prompt Pro is the flagship model. 100X Prompt Flash is lightweight.",
      permittedPrincipals: ["u"],
    })
    const n = (store.db.query("SELECT COUNT(*) c FROM nodes WHERE coll='entities'").get() as { c: number }).c
    expect(n).toBeGreaterThan(0) // deterministic extractor still runs when nothing supplied
  })
})
