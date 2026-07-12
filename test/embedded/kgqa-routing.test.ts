// Intelligent KGQA routing (LightRAG-style dual-level): self/preference + predicate
// anchoring, so abstract self-queries resolve through the GRAPH, not vector search.
import { test, expect, describe } from "bun:test"
import { buildEmbeddedContext } from "../../src/embedded/index"

async function withGraph() {
  const ctx = buildEmbeddedContext({ path: ":memory:" })
  ctx.ingestor.registerUser("u", "o", "u@x.com", "admin")
  // typed preference facts (as the frontier model would supply)
  await ctx.authorizedIngest("u", {
    recordId: "prefs", orgId: "o", recordName: "prefs", text: "The user loves coding and loves Lavanya.",
    permittedPrincipals: ["u"],
    entities: [{ name: "User" }, { name: "coding" }, { name: "Lavanya" }],
    relations: [
      { from: "User", to: "coding", type: "loves" },
      { from: "User", to: "Lavanya", type: "loves" },
    ],
  })
  // an unrelated relational fact
  await ctx.authorizedIngest("u", {
    recordId: "deal", orgId: "o", recordName: "deal", text: "SAP partnered with Google Cloud.",
    permittedPrincipals: ["u"],
    entities: [{ name: "SAP" }, { name: "Google Cloud" }],
    relations: [{ from: "SAP", to: "Google Cloud", type: "partners_with" }],
  })
  return ctx
}

describe("self/preference routing", () => {
  test("abstract self-query (no entity named) resolves to preference edges via the graph", async () => {
    const ctx = await withGraph()
    const ans = await ctx.ask("preferences logic brain intellectual challenging", "u", "o")
    expect(ans).not.toBeNull()
    expect(ans!.confidence).toBeGreaterThanOrEqual(0.7) // graph answer, not vector fallback
    expect(ans!.answer.toLowerCase()).toContain("coding")
    expect(ans!.answer.toLowerCase()).toContain("lavanya")
  })

  test("'do i like anything logical' routes to the graph", async () => {
    const ctx = await withGraph()
    const ans = await ctx.ask("do I like anything logical", "u", "o")
    expect(ans?.answer.toLowerCase()).toContain("coding")
  })

  test("does NOT hijack a relational query about another entity", async () => {
    const ctx = await withGraph()
    // "love" verb but no self pronoun → must NOT return the user's preferences
    const ans = await ctx.ask("does Google Cloud love SAP", "u", "o")
    // either resolves to the SAP/Google relation or nothing - but never the user's coding pref
    if (ans) expect(ans.answer.toLowerCase()).not.toContain("coding")
  })
})

describe("predicate-anchored routing", () => {
  test("a relation-themed query with no entity returns edges of that predicate", async () => {
    const ctx = await withGraph()
    const ans = await ctx.ask("show partnerships", "u", "o")
    expect(ans).not.toBeNull()
    expect(ans!.answer).toContain("SAP")
    expect(ans!.answer).toContain("Google Cloud")
  })
})
