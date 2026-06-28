// Full-loop proof: ingest real documents (not hand-seeded), then resolve context.
// Verifies the CREATE side (graph + vectors) wires correctly to the READ side, and
// that ACLs captured at ingest are enforced at query time.

import { beforeEach, describe, expect, test } from "bun:test"
import { buildEmbeddedContext, type EmbeddedContext } from "../../src/embedded/index"
import { chunkText } from "../../src/embedded/ingest"
import { RetrievalStatus } from "../../src/types"

describe("ingestion → resolution (complete system)", () => {
  let ctx: EmbeddedContext
  beforeEach(async () => {
    ctx = buildEmbeddedContext({ path: ":memory:" })
    const ing = ctx.ingestor
    ing.registerOrg("org1")
    ing.registerUser("alice", "org1", "alice@acme.co")
    ing.registerUser("bob", "org1", "bob@acme.co")
    ing.registerGroup("finance")
    ing.addMembership("alice", "finance") // only alice is in finance

    // Org-wide doc (anyone in org).
    await ing.ingest({
      recordId: "doc-handbook",
      orgId: "org1",
      recordName: "Employee Handbook",
      text: "Vacation policy: employees accrue paid time off monthly.\n\nRemote work is allowed.",
      shareWithOrg: "org1",
    })
    // Finance-only doc (group permission).
    await ing.ingest({
      recordId: "doc-budget",
      orgId: "org1",
      recordName: "Confidential Budget",
      text: "The confidential Q4 budget allocates funds to acquisition targets.",
      permittedPrincipals: ["finance"],
    })
  })

  test("chunkText keeps a short heading attached to its content", () => {
    const out = chunkText("PRICING TIERS:\n\nPro is $99, Flash is $29, Enterprise is custom.")
    expect(out.length).toBe(1)
    expect(out[0]).toContain("PRICING TIERS:")
    expect(out[0]).toContain("Pro is $99")
  })

  test("chunkText hard-splits oversized blocks", () => {
    expect(chunkText("x".repeat(2000), 800).length).toBeGreaterThan(1)
  })

  test("alice (finance) can retrieve the confidential budget", async () => {
    const res = await ctx.retrieval.searchWithFilters({ queries: ["confidential budget acquisition"], userId: "alice", orgId: "org1" })
    expect(res.searchResults.map((r) => r.metadata.recordName)).toContain("Confidential Budget")
  })

  test("bob (not finance) CANNOT retrieve the confidential budget", async () => {
    const res = await ctx.retrieval.searchWithFilters({ queries: ["confidential budget acquisition"], userId: "bob", orgId: "org1" })
    expect(res.searchResults.map((r) => r.metadata.recordName)).not.toContain("Confidential Budget")
  })

  test("both can retrieve the org-wide handbook", async () => {
    for (const userId of ["alice", "bob"]) {
      const res = await ctx.retrieval.searchWithFilters({ queries: ["vacation policy time off"], userId, orgId: "org1" })
      expect(res.searchResults.map((r) => r.metadata.recordName)).toContain("Employee Handbook")
    }
  })

  test("ingest reports chunk count and the doc becomes accessible", async () => {
    const out = await ctx.ingestor.ingest({
      recordId: "doc-new",
      orgId: "org1",
      recordName: "New Note",
      text: "First para about widgets.\n\nSecond para about gadgets.",
      permittedPrincipals: ["bob"],
    })
    // short paragraphs now merge into one chunk (heading-attach behavior)
    expect(out.chunks).toBe(1)
    const map = await ctx.graph.getAccessibleVirtualRecordIds({ userId: "bob", orgId: "org1" })
    expect(map["doc-new"]).toBe("doc-new")
  })

  test("unknown user still denied after ingestion", async () => {
    const res = await ctx.retrieval.searchWithFilters({ queries: ["budget"], userId: "ghost", orgId: "org1" })
    expect(res.status).toBe(RetrievalStatus.ACCESSIBLE_RECORDS_NOT_FOUND)
  })
})
