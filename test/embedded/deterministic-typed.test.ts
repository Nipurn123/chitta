// LLM-FREE cognition: the deterministic extractor now emits TYPED relations (works_at,
// lives_in…) from high-precision verb patterns - which activates the whole living-memory
// stack (typed graph edges + atomic memories + functional supersession) with ZERO LLM
// tokens. This is the core of the "intelligent in itself" vision: point it at prose, get a
// queryable, self-correcting memory - no model, no API, no tokens.

import { describe, expect, test } from "bun:test"
import { extractKnowledge } from "../../src/embedded/extract"
import { buildEmbeddedContext } from "../../src/embedded/index"

describe("deterministic typed extraction", () => {
  test("high-precision verb patterns produce TYPED predicates (not just relates_to)", () => {
    const { relations } = extractKnowledge("Sarah Chen works at Meta. Sarah Chen lives in Berlin. Acme acquired Globex.")
    const preds = new Set(relations.map((r) => r.type))
    expect(preds.has("works_at")).toBe(true)
    expect(preds.has("lives_in")).toBe(true)
    expect(preds.has("acquired")).toBe(true)
  })

  test("hardening: negation is not a false positive, punctuation trimmed, new predicates covered", () => {
    // "does not work at" - the verb isn't adjacent to the subject, so no false works_at edge
    expect(extractKnowledge("Sarah Chen does not work at Meta.").relations.some((r) => r.type === "works_at")).toBe(false)
    // over-captured trailing "." is trimmed from the entity label
    const meta = extractKnowledge("Sarah Chen works at Meta.").entities.find((e) => e.id === "meta")
    expect(meta?.label).toBe("Meta")
    // expanded predicate coverage (richer typed graph)
    expect(extractKnowledge("Bob Smith manages Sales Team").relations.some((r) => r.type === "manages")).toBe(true)
    expect(extractKnowledge("Alice authored Deep Memory").relations.some((r) => r.type === "authored")).toBe(true)
    expect(extractKnowledge("Acme is headquartered in Berlin").relations.some((r) => r.type === "headquartered_in")).toBe(true)
  })

  test("deterministic ingest builds typed edges + recallable memories (no LLM, no tokens)", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" }) // hash embedder (test preload) - fully offline
    ctx.ingestor.registerUser("u", "o", "e", "admin")
    await ctx.authorizedIngest("u", {
      recordId: "r1", orgId: "o", recordName: "note",
      text: "Sarah Chen works at Meta. Sarah Chen lives in Berlin.",
      permittedPrincipals: ["u"],
    })
    // typed graph edge exists (activates KGQA / graph retrieval)
    expect(ctx.store.db.query("SELECT 1 FROM edges WHERE label = 'works_at'").get()).not.toBeNull()
    // and the living-memory layer has an ATOMIC, recallable fact - with no LLM in the loop
    const mems = (await ctx.recallMemories("where does Sarah Chen work", "u", "o")).map((m) => m.memory).join(" | ")
    expect(mems).toContain("Meta")
  })

  test("functional supersession works LLM-free (contradiction → current truth)", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o", "e", "admin")
    await ctx.authorizedIngest("u", { recordId: "r1", orgId: "o", recordName: "n", text: "Sarah Chen works at Meta.", permittedPrincipals: ["u"] })
    await ctx.authorizedIngest("u", { recordId: "r2", orgId: "o", recordName: "n", text: "Sarah Chen works at OpenAI.", permittedPrincipals: ["u"] })
    const mems = (await ctx.recallMemories("where does Sarah Chen work", "u", "o")).map((m) => m.memory).join(" | ")
    expect(mems).toContain("OpenAI") // current truth
    expect(mems).not.toContain("Meta") // superseded, all without an LLM
  })
})
