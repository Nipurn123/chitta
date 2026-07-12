// The graph hop is now SCALE-INVARIANT (bounded to a fixed budget regardless of graph size)
// WITHOUT losing the multi-hop it exists for: evidence reachable only through a SPECIFIC
// (non-hub) shared entity still surfaces, while a HUB entity can no longer flood the pool.
// That bound is what makes millisecond-at-any-scale retrieval possible, zero-token.

import { describe, expect, test } from "bun:test"
import { buildEmbeddedContext } from "../../src/embedded/index"

describe("bounded (O(1)-in-N) graph expansion", () => {
  test("a genuine 2-hop bridge through a SPECIFIC entity still surfaces", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o", "e", "admin")
    // A: Alice ↔ Project Zephyr (specific).  B: Project Zephyr ↔ PostgreSQL.
    await ctx.authorizedIngest("u", {
      recordId: "A", orgId: "o", recordName: "a", text: "Alice Nguyen works on Project Zephyr.", permittedPrincipals: ["u"],
      entities: [{ name: "Alice Nguyen", type: "PERSON" }, { name: "Project Zephyr", type: "PROJECT" }],
      relations: [{ from: "Alice Nguyen", to: "Project Zephyr", type: "works_on" }],
    })
    await ctx.authorizedIngest("u", {
      recordId: "B", orgId: "o", recordName: "b", text: "Project Zephyr runs on PostgreSQL.", permittedPrincipals: ["u"],
      entities: [{ name: "Project Zephyr", type: "PROJECT" }, { name: "PostgreSQL", type: "TECH" }],
      relations: [{ from: "Project Zephyr", to: "PostgreSQL", type: "runs_on" }],
    })
    const acc = await ctx.graph.getAccessibleVirtualRecordIds({ userId: "u", orgId: "o" })
    const rids = [...new Set(Object.values(acc))] as string[]
    // seed from A → the bounded hop must still return B (reached via the specific entity).
    expect(ctx.graph.getRelatedRecordIds(["A"], new Set(rids), 5)).toContain("B")
  })

  test("a HUB entity does not flood the hop (stays bounded)", async () => {
    process.env.CONTEXT_GRAPH_HUB = "10"
    try {
      const ctx = buildEmbeddedContext({ path: ":memory:" })
      ctx.ingestor.registerUser("u", "o", "e", "admin")
      // 40 records all share the hub "Acme" - seeding from one must NOT pull in all the others.
      for (let i = 0; i < 40; i++)
        await ctx.authorizedIngest("u", {
          recordId: `h${i}`, orgId: "o", recordName: `h${i}`, text: `Person${i} works at Acme.`, permittedPrincipals: ["u"],
          entities: [{ name: `Person${i}`, type: "PERSON" }, { name: "Acme", type: "ORG" }],
          relations: [{ from: `Person${i}`, to: "Acme", type: "works_at" }],
        })
      const acc = await ctx.graph.getAccessibleVirtualRecordIds({ userId: "u", orgId: "o" })
      const rids = [...new Set(Object.values(acc))] as string[]
      expect(ctx.graph.getRelatedRecordIds(["h0"], new Set(rids), 5).length).toBeLessThanOrEqual(5) // capped, not flooded
    } finally {
      delete process.env.CONTEXT_GRAPH_HUB
    }
  })

  test("the legacy flag (CONTEXT_GRAPH_BOUNDED=0) still returns the specific bridge", async () => {
    process.env.CONTEXT_GRAPH_BOUNDED = "0"
    try {
      const ctx = buildEmbeddedContext({ path: ":memory:" })
      ctx.ingestor.registerUser("u", "o", "e", "admin")
      await ctx.authorizedIngest("u", {
        recordId: "A", orgId: "o", recordName: "a", text: "Alice Nguyen works on Project Zephyr.", permittedPrincipals: ["u"],
        entities: [{ name: "Alice Nguyen", type: "PERSON" }, { name: "Project Zephyr", type: "PROJECT" }],
        relations: [{ from: "Alice Nguyen", to: "Project Zephyr", type: "works_on" }],
      })
      await ctx.authorizedIngest("u", {
        recordId: "B", orgId: "o", recordName: "b", text: "Project Zephyr runs on PostgreSQL.", permittedPrincipals: ["u"],
        entities: [{ name: "Project Zephyr", type: "PROJECT" }, { name: "PostgreSQL", type: "TECH" }],
        relations: [{ from: "Project Zephyr", to: "PostgreSQL", type: "runs_on" }],
      })
      const acc = await ctx.graph.getAccessibleVirtualRecordIds({ userId: "u", orgId: "o" })
      const rids = [...new Set(Object.values(acc))] as string[]
      expect(ctx.graph.getRelatedRecordIds(["A"], new Set(rids), 5)).toContain("B")
    } finally {
      delete process.env.CONTEXT_GRAPH_BOUNDED
    }
  })
})
