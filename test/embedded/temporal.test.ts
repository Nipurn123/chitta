// Reflection + temporal reasoning - the cognition layer over the bi-temporal store.
// Timeline (how a subject evolved), as-of (memory time-travel), reflect (insight synthesis),
// and GraphRAG community summaries. All ACL-scoped.

import { describe, expect, test } from "bun:test"
import { buildEmbeddedContext } from "../../src/embedded/index"

// Ingest "Sarah works at Meta", back-date that fact, then supersede it with "…OpenAI".
async function sarahChangedJobs() {
  const ctx = buildEmbeddedContext({ path: ":memory:" })
  ctx.ingestor.registerUser("u", "o")
  await ctx.ingestor.ingest({
    recordId: "r1", orgId: "o", recordName: "Intro", text: "x", permittedPrincipals: ["u"],
    entities: [{ name: "Sarah Chen", type: "PERSON" }, { name: "Meta", type: "ORG" }],
    relations: [{ from: "Sarah Chen", to: "Meta", type: "works_at" }],
  })
  // Back-date the first fact so we have a real gap on the transaction-time axis.
  ctx.store.db.query("UPDATE memories SET created_at = ? WHERE memory = ?").run(Date.parse("2020-01-01"), "Sarah Chen works at Meta")
  await ctx.ingestor.ingest({
    recordId: "r2", orgId: "o", recordName: "Update", text: "x", permittedPrincipals: ["u"],
    entities: [{ name: "Sarah", type: "PERSON" }, { name: "OpenAI", type: "ORG" }],
    relations: [{ from: "Sarah", to: "OpenAI", type: "works_at" }],
  })
  return ctx
}

describe("temporal reasoning", () => {
  test("as-of reconstructs the PAST belief state (memory time-travel)", async () => {
    const ctx = await sarahChangedJobs()
    const back = await ctx.asOf(Date.parse("2021-06-01"), "u", "o")
    expect(back.join(" ")).toContain("Meta") // in 2021 we believed Meta
    expect(back.join(" ")).not.toContain("OpenAI")

    const now = await ctx.asOf(Date.now(), "u", "o")
    expect(now.join(" ")).toContain("OpenAI") // today we know OpenAI
    expect(now.join(" ")).not.toContain("Meta") // the superseded value is gone
  })

  test("timeline interleaves fact changes + experiences chronologically and marks superseded", async () => {
    const ctx = await sarahChangedJobs()
    await ctx.ingestor.ingest({
      recordId: "r3", orgId: "o", recordName: "Coffee", text: "x", permittedPrincipals: ["u"],
      episodes: [{ event: "Had coffee with Sarah to talk about the move", occurredAt: "2024-03-03", actors: ["Sarah"] }],
    })
    const tl = await ctx.timeline("Sarah", "u", "o")
    const metaEvent = tl.events.find((e) => e.text.includes("Meta"))
    const openaiEvent = tl.events.find((e) => e.text.includes("OpenAI"))
    const episode = tl.events.find((e) => e.kind === "episode")
    expect(metaEvent?.superseded).toBe(true) // Meta was later changed
    expect(openaiEvent?.superseded).toBe(false) // OpenAI is current
    expect(episode).toBeDefined()
    // chronological: the 2020 Meta fact precedes the 2024 coffee episode
    expect(tl.events.indexOf(metaEvent!)).toBeLessThan(tl.events.indexOf(episode!))
  })
})

describe("reflection", () => {
  test("synthesizes change + preference insights over the accessible set", async () => {
    const ctx = await sarahChangedJobs()
    await ctx.ingestor.ingest({
      recordId: "r4", orgId: "o", recordName: "Prefs", text: "x", permittedPrincipals: ["u"],
      procedures: [{ trigger: "the user asks for code", action: "use TypeScript, no comments" }],
    })
    const insights = await ctx.reflect("u", "o")
    expect(insights.some((i) => i.category === "change" && i.text.includes("Meta") && i.text.includes("OpenAI"))).toBe(true)
    expect(insights.some((i) => i.category === "preference" && i.text.includes("TypeScript"))).toBe(true)
  })

  test("reflection is ACL-scoped - a stranger sees nothing", async () => {
    const ctx = await sarahChangedJobs()
    ctx.ingestor.registerUser("stranger", "o")
    expect((await ctx.reflect("stranger", "o")).length).toBe(0)
  })
})

describe("community summaries (GraphRAG)", () => {
  test("each cluster carries a human-readable summary naming its hub", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o")
    await ctx.ingestor.ingest({
      recordId: "r1", orgId: "o", recordName: "Org", text: "x", permittedPrincipals: ["u"],
      entities: [{ name: "Acme", type: "ORG" }, { name: "Sarah", type: "PERSON" }, { name: "Bob", type: "PERSON" }],
      relations: [
        { from: "Sarah", to: "Acme", type: "works_at" },
        { from: "Bob", to: "Acme", type: "works_at" },
      ],
    })
    const cs = await ctx.graphQuery.communities("u", "o")
    expect(cs.length).toBeGreaterThan(0)
    expect(cs[0].summary).toContain("cluster of")
    expect(cs[0].summary.length).toBeGreaterThan(10)
  })
})
