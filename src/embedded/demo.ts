// Single-binary demo. Compile with:
//   bun build src/context/embedded/demo.ts --compile --outfile ctxdemo
// Then run ./ctxdemo - one self-contained executable, no servers, no Python.

import { buildEmbeddedContext, LocalHashEmbeddings } from "./index"

async function main() {
  const ctx = buildEmbeddedContext({ path: ":memory:" })
  const emb = new LocalHashEmbeddings()
  const ORG = "org1"
  const rec = (id: string, vid: string, name: string) => ({
    _key: id, virtualRecordId: vid, orgId: ORG, indexingStatus: "COMPLETED",
    origin: "CONNECTOR", recordName: name, mimeType: "text/plain", connectorId: "slack", connectorName: "slack",
  })

  ctx.store.addNode("org1", "organizations", { name: "Acme" })
  ctx.store.addNode("alice", "users", { userId: "alice", email: "alice@acme.co" })
  ctx.store.addNode("bob", "users", { userId: "bob", email: "bob@acme.co" })
  ctx.store.addEdge("alice", "org1", "belongsTo")
  ctx.store.addEdge("bob", "org1", "belongsTo")
  ctx.store.addNode("recPub", "records", rec("recPub", "vPub", "Q3 Revenue Report"))
  ctx.store.addNode("anyPub", "anyone", { organization: ORG, file_key: "recPub" })
  ctx.store.addNode("recSec", "records", rec("recSec", "vSec", "Secret Merger Plans"))
  ctx.store.addEdge("alice", "recSec", "permissions")
  ctx.store.addChunk("p1", "vPub", ORG, "quarterly revenue report Q3", await emb.embedDense("quarterly revenue report"))
  ctx.store.addChunk("p2", "vSec", ORG, "secret merger plans globex", await emb.embedDense("secret merger plans globex"))

  for (const user of ["alice", "bob"]) {
    const res = await ctx.retrieval.searchWithFilters({ queries: ["secret merger plans"], userId: user, orgId: ORG })
    const names = res.searchResults.map((r) => r.metadata.recordName)
    console.log(`${user} → [${names.join(", ") || "nothing"}]`)
  }
  console.log("(expected: alice sees the Secret doc; bob does NOT - ACL enforced in one binary)")
}

main()
