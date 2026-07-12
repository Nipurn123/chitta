// Episodic + procedural memory - the memory typology beyond timeless semantic facts.
// Episodic = time-anchored experiences (ranked by relevance × recency, linked to the
// canonical entities involved); procedural = learned how-tos / preferences that supersede
// on change. Both are ACL-scoped and never leak into semantic recall.

import { describe, expect, test } from "bun:test"
import { buildEmbeddedContext } from "../../src/embedded/index"

describe("episodic memory", () => {
  test("an experience is recalled, its actor is linked to the canonical entity, and it does not leak into facts", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o")
    await ctx.ingestor.ingest({
      recordId: "r1",
      orgId: "o",
      recordName: "Meeting",
      text: "Notes from the meeting.",
      permittedPrincipals: ["u"],
      episodes: [{ event: "Met Sarah at the Anthropic office to scope the memory layer", occurredAt: "2026-07-01", actors: ["Sarah"] }],
    })

    const eps = await ctx.recallEpisodes("Sarah Anthropic memory layer meeting", "u", "o")
    expect(eps.length).toBe(1)
    expect(eps[0].event).toContain("Sarah")
    expect(eps[0].actorIds.some((id) => id.includes("sarah"))).toBe(true) // linked to the canonical entity

    // The actor became a real graph entity (mention edge from the record).
    expect(ctx.store.db.query("SELECT 1 FROM nodes WHERE id = 'entity:sarah'").get()).not.toBeNull()

    // Episodes are NOT semantic facts - they never appear in the current-facts layer.
    const facts = await ctx.recallMemories("Sarah", "u", "o")
    expect(facts.length).toBe(0)
  })

  test("recency breaks ties - the more recent of two equally-relevant experiences ranks first", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o")
    await ctx.ingestor.ingest({
      recordId: "r1", orgId: "o", recordName: "Log", text: "log", permittedPrincipals: ["u"],
      episodes: [
        { event: "Discussed the product roadmap with the team", occurredAt: "2020-01-01" },
        { event: "Discussed the product roadmap with the team", occurredAt: "2026-07-01" },
      ],
    })
    const eps = await ctx.recallEpisodes("product roadmap discussion team", "u", "o")
    expect(eps.length).toBe(2)
    expect(eps[0].occurredAt).toBeGreaterThan(eps[1].occurredAt) // newer first
  })

  test("a stranger cannot recall another user's experiences (ACL holds)", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("owner", "o")
    ctx.ingestor.registerUser("stranger", "o")
    await ctx.ingestor.ingest({
      recordId: "r1", orgId: "o", recordName: "Private", text: "x", permittedPrincipals: ["owner"],
      episodes: [{ event: "Signed the acquisition term sheet", occurredAt: "2026-06-01" }],
    })
    expect((await ctx.recallEpisodes("acquisition term sheet", "owner", "o")).length).toBe(1)
    expect((await ctx.recallEpisodes("acquisition term sheet", "stranger", "o")).length).toBe(0)
  })
})

describe("procedural memory", () => {
  test("a how-to is recalled and a new action for the same trigger supersedes the old one", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o")
    await ctx.ingestor.ingest({
      recordId: "r1", orgId: "o", recordName: "Prefs", text: "x", permittedPrincipals: ["u"],
      procedures: [{ trigger: "the user asks for code", action: "use TypeScript with no comments" }],
    })
    let procs = await ctx.recallProcedures("writing code for the user", "u", "o")
    expect(procs.length).toBe(1)
    expect(procs[0].procedure).toContain("TypeScript")

    // The preference changes: a new action for the SAME trigger supersedes (v2), history kept.
    await ctx.ingestor.ingest({
      recordId: "r2", orgId: "o", recordName: "Prefs2", text: "x", permittedPrincipals: ["u"],
      procedures: [{ trigger: "the user asks for code", action: "use Python with type hints" }],
    })
    procs = await ctx.recallProcedures("writing code for the user", "u", "o")
    expect(procs.length).toBe(1) // still one CURRENT procedure for this trigger
    expect(procs[0].procedure).toContain("Python")
    expect(procs[0].procedure).not.toContain("TypeScript")
    expect(procs[0].version).toBe(2)
  })
})
