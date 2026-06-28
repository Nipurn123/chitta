// Live proof of the single-binary path: the SAME RetrievalService + ACL invariant
// run against a real embedded SQLite database - no Arango, no Qdrant, no servers.
// Two users, one shared doc, one private doc; we prove user B can never retrieve
// user A's private record even though it's indexed in the same store.

import { beforeEach, describe, expect, test } from "bun:test"
import { buildEmbeddedContext, type EmbeddedContext, LocalHashEmbeddings } from "../../src/embedded/index"
import { RetrievalStatus } from "../../src/types"

async function seed(ctx: EmbeddedContext) {
  const { store } = ctx
  const emb = new LocalHashEmbeddings()
  const ORG = "org1"

  // Principals
  store.addNode("org1", "organizations", { name: "Acme" })
  store.addNode("alice", "users", { userId: "alice", email: "alice@acme.co" })
  store.addNode("bob", "users", { userId: "bob", email: "bob@acme.co" })
  store.addEdge("alice", "org1", "belongsTo")
  store.addEdge("bob", "org1", "belongsTo")

  const record = (id: string, vid: string, name: string) => ({
    _key: id,
    virtualRecordId: vid,
    orgId: ORG,
    indexingStatus: "COMPLETED",
    origin: "CONNECTOR",
    recordName: name,
    mimeType: "text/plain",
    connectorId: "slack",
    connectorName: "slack",
  })

  // Public doc: shared org-wide via "anyone" → both users.
  store.addNode("recPub", "records", record("recPub", "vPub", "Q3 Revenue Report"))
  store.addNode("anyPub", "anyone", { organization: ORG, file_key: "recPub" })

  // Private doc: direct permission to alice only.
  store.addNode("recSec", "records", record("recSec", "vSec", "Secret Merger Plans"))
  store.addEdge("alice", "recSec", "permissions")

  // Chunks (vectors) for both docs.
  store.addChunk("p1", "vPub", ORG, "quarterly revenue report numbers for Q3", await emb.embedDense("quarterly revenue report numbers"))
  store.addChunk("p2", "vSec", ORG, "secret merger plans with globex acquisition", await emb.embedDense("secret merger plans globex acquisition"))
}

describe("embedded single-binary stack - ACL holds against a real SQLite db", () => {
  let ctx: EmbeddedContext
  beforeEach(async () => {
    ctx = buildEmbeddedContext({ path: ":memory:" })
    await seed(ctx)
  })

  test("accessible map: alice sees both, bob sees only the public doc", async () => {
    const aMap = await ctx.graph.getAccessibleVirtualRecordIds({ userId: "alice", orgId: "org1" })
    const bMap = await ctx.graph.getAccessibleVirtualRecordIds({ userId: "bob", orgId: "org1" })
    expect(new Set(Object.keys(aMap))).toEqual(new Set(["vPub", "vSec"]))
    expect(Object.keys(bMap)).toEqual(["vPub"]) // bob cannot reach the private record
  })

  test("alice can retrieve the secret merger doc", async () => {
    const res = await ctx.retrieval.searchWithFilters({
      queries: ["merger plans"],
      userId: "alice",
      orgId: "org1",
    })
    expect(res.status).toBe(RetrievalStatus.SUCCESS)
    const names = res.searchResults.map((r) => r.metadata.recordName)
    expect(names).toContain("Secret Merger Plans")
  })

  test("bob searching the SAME query never gets the secret doc (the leak test)", async () => {
    const res = await ctx.retrieval.searchWithFilters({
      queries: ["secret merger plans"],
      userId: "bob",
      orgId: "org1",
    })
    const names = res.searchResults.map((r) => r.metadata.recordName)
    const vids = res.searchResults.map((r) => r.metadata.virtualRecordId)
    expect(names).not.toContain("Secret Merger Plans")
    expect(vids).not.toContain("vSec")
    expect(res.searchResults.every((r) => r.content.includes("merger") === false || r.metadata.virtualRecordId === "vPub")).toBe(true)
  })

  test("both users can retrieve the public doc", async () => {
    for (const userId of ["alice", "bob"]) {
      const res = await ctx.retrieval.searchWithFilters({ queries: ["revenue report"], userId, orgId: "org1" })
      expect(res.searchResults.map((r) => r.metadata.recordName)).toContain("Q3 Revenue Report")
    }
  })

  test("unknown user gets nothing (deny by default)", async () => {
    const res = await ctx.retrieval.searchWithFilters({ queries: ["revenue"], userId: "ghost", orgId: "org1" })
    expect(res.status).toBe(RetrievalStatus.ACCESSIBLE_RECORDS_NOT_FOUND)
  })
})
