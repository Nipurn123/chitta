// Knowledge-graph extraction: ingest real text → concept nodes + relationships,
// queryable as an ACL-respecting graph.

import { describe, expect, test } from "bun:test"
import { extractKnowledge } from "../../src/embedded/extract"
import { buildEmbeddedContext } from "../../src/embedded/index"

describe("extractKnowledge", () => {
  test("pulls multi-word concepts and acronyms", () => {
    const { entities } = extractKnowledge("100X Prompt Pro is our flagship LLM. SOC-II Type 2 certified.")
    const labels = entities.map((e) => e.label)
    expect(labels).toContain("100X Prompt Pro")
    expect(labels.some((l) => l.startsWith("SOC-II"))).toBe(true)
  })

  test("relates concepts that co-occur", () => {
    const { relations } = extractKnowledge("100X Prompt Pro and 100X Prompt Flash are sovereign models")
    expect(relations.length).toBeGreaterThan(0)
  })
})

describe("ingest builds a real knowledge graph", () => {
  test("entities + relations land in the graph and are queryable per-user", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o")
    const out = await ctx.ingestor.ingest({
      recordId: "platform",
      orgId: "o",
      recordName: "Platform",
      text: "100X Prompt Pro is the flagship LLM. 100X Prompt Flash is lightweight. Both are Sovereign Models.",
      permittedPrincipals: ["u"],
    })
    expect(out.entities).toBeGreaterThan(0)

    const accessible = await ctx.graph.getAccessibleVirtualRecordIds({ userId: "u", orgId: "o" })
    const recordIds = [...new Set(Object.values(accessible))]
    const g = ctx.graph.getKnowledgeGraph(recordIds)

    const labels = g.entities.map((e) => e.label)
    expect(labels).toContain("100X Prompt Pro")
    expect(labels).toContain("100X Prompt Flash")
    expect(g.relations.length).toBeGreaterThan(0)
  })

  test("a user with no access sees an empty graph (ACL holds for the graph too)", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("owner", "o")
    ctx.ingestor.registerUser("stranger", "o")
    await ctx.ingestor.ingest({
      recordId: "secret",
      orgId: "o",
      recordName: "Secret",
      text: "Project Aurora uses Quantum Encryption.",
      permittedPrincipals: ["owner"],
    })
    const acc = await ctx.graph.getAccessibleVirtualRecordIds({ userId: "stranger", orgId: "o" })
    const g = ctx.graph.getKnowledgeGraph([...new Set(Object.values(acc))])
    expect(g.entities.length).toBe(0) // stranger can't see the concepts either
  })
})
