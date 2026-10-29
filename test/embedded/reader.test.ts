// Memory reader: gathers each session's facts + best rounds in date order under a budget, reads
// with a stub model, routes wide questions to a wider search, and parses the router's JSON.
import { test, expect, describe } from "bun:test"
import { buildEmbeddedContext } from "../../src/embedded/index"
import { answerQuestion, gatherMemory, readMemory } from "../../src/embedded/reader"
import { LlmExtractor } from "../../src/embedded/llm-extractor"

async function store() {
  const ctx = buildEmbeddedContext({ path: ":memory:" })
  ctx.ingestor.registerUser("u", "o", "u@x.com", "admin")
  const add = (id: string, date: string, text: string, facts: string[]) =>
    ctx.authorizedIngest("u", { recordId: id, orgId: "o", recordName: id, text, permittedPrincipals: ["u"], occurredAt: date, facts })
  await add("later", "2024-05-02", "alice: I bought a second camera lens today.\nbob: Nice!\nalice: It's a 50mm.\nbob: Great for portraits.", ["The user bought a 50mm lens."])
  await add("earlier", "2024-03-10", "alice: I bought my first camera lens.\nbob: Which one?\nalice: A 35mm.\nbob: Classic.", ["The user bought a 35mm lens."])
  return ctx
}

describe("gatherMemory", () => {
  test("sessions are dated, in date order, with their facts and excerpts", async () => {
    const ctx = await store()
    const { text, included } = await gatherMemory(ctx, "how many lenses did I buy?", ["later", "earlier"])
    expect(included).toEqual(["earlier", "later"]) // chronological, not rank order
    expect(text.indexOf("### Session 2024-03-10")).toBeLessThan(text.indexOf("### Session 2024-05-02"))
    expect(text).toContain("- The user bought a 35mm lens.")
    expect(text).toContain("Excerpts:")
    expect(text).not.toContain("[2024-03-10] ") // the chunk header is folded into the session header
  })

  test("past the full tier a session contributes its facts only", async () => {
    const ctx = await store()
    const { text } = await gatherMemory(ctx, "lens", ["later", "earlier"], { full: 1 })
    const earlier = text.slice(text.indexOf("### Session 2024-03-10"), text.indexOf("### Session 2024-05-02"))
    expect(earlier).toContain("- The user bought a 35mm lens.")
    expect(earlier).not.toContain("Excerpts:") // rank 2 is past the full tier
    expect(text.slice(text.indexOf("### Session 2024-05-02"))).toContain("Excerpts:")
  })

  test("the budget keeps the highest-ranked sessions", async () => {
    const ctx = await store()
    const { included } = await gatherMemory(ctx, "lens", ["later", "earlier"], { budget: 200 })
    expect(included).toEqual(["later"])
  })
})

describe("reading", () => {
  test("readMemory returns the ANSWER line and the notes before it", async () => {
    const model = { complete: async () => "NOTES:\n- 2024-03-10: 35mm\n- 2024-05-02: 50mm\nANSWER: Two lenses." }
    expect(await readMemory(model, "how many?", "mem", "2024-06-01", "aggregate")).toEqual({ answer: "Two lenses.", notes: "NOTES:\n- 2024-03-10: 35mm\n- 2024-05-02: 50mm" })
  })

  test("notes without an ANSWER line get one follow-up call for the final answer", async () => {
    const calls: string[] = []
    const model = { complete: async (system: string) => (calls.push(system), calls.length === 1 ? "NOTES: 35mm in March, 50mm in May" : "Two lenses.") }
    const r = await readMemory(model, "how many lenses?", "mem", "2024-06-01", "aggregate")
    expect(calls).toHaveLength(2)
    expect(r).toEqual({ answer: "Two lenses.", notes: "NOTES: 35mm in March, 50mm in May" })
  })

  test("answerQuestion routes, searches wide for counting questions, and reads both sessions", async () => {
    const ctx = await store()
    let limit = 0
    let expansions: string[] | undefined
    let prompt = ""
    const res = await answerQuestion(
      {
        store: ctx.store,
        embeddings: ctx.embeddings,
        search: (q, u, o, t, l, opts) => ((limit = l), (expansions = opts.expansions), ctx.searchWithGraph(q, u, o, t, l, opts)),
      },
      "How many camera lenses have I bought?",
      "u",
      "o",
      {
        now: "2024-06-01",
        model: {
          routeQuestion: async () => ({ kind: "aggregate", queries: ["camera lens purchases"] }),
          complete: async (_s, user) => ((prompt = user), "NOTES: two purchases\nANSWER: 2"),
        },
      },
    )
    expect(limit).toBe(30) // wide
    expect(expansions).toEqual(["camera lens purchases"])
    expect(prompt).toStartWith("TODAY: 2024-06-01")
    expect(res).toMatchObject({ answer: "2", kind: "aggregate" })
    expect(res.recordIds.sort()).toEqual(["earlier", "later"])
  })

  test("routeQuestion parses kind + queries, and falls back on junk", async () => {
    const fake = (reply: string) =>
      (async () => new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), { status: 200 })) as unknown as typeof fetch
    const ok = new LlmExtractor({ endpoint: "http://x", model: "m", fetchImpl: fake('{"kind":"temporal","queries":["trip to Rome dates"]}') })
    expect(await ok.routeQuestion("when was my Rome trip?")).toEqual({ kind: "temporal", queries: ["trip to Rome dates"] })
    const bad = new LlmExtractor({ endpoint: "http://x", model: "m", fetchImpl: fake("no idea") })
    expect(await bad.routeQuestion("q")).toEqual({ kind: "single", queries: [] })
  })
})

describe("round ranking inside a session", () => {
  test("a passing remark with the question's words beats rounds that are only about the topic", async () => {
    const { rankRounds } = await import("../../src/embedded/reader")
    // dense vectors favour the insurance rounds; the remark holds the question's own words
    const v = (x: number) => Float32Array.from([x, Math.sqrt(1 - x * x)])
    const rounds = [
      { c: "user: How do I update my credit card details?", v: v(0.7) },
      { c: "user: Can I update my bank account online?", v: v(0.69) },
      { c: "user: I need my health insurance address updated. By the way, I recently changed my last name - my old name was Johnson.", v: v(0.66) },
      { c: "user: What documents does the passport office need?", v: v(0.68) },
    ]
    const order = rankRounds("What was my last name before I changed it?", [1, 0], rounds)
    expect(order[0]).toBe(2)
  })

  test("the chunk the search returned is always among the excerpts, even when it ranks low", async () => {
    const ctx = await store()
    const low = (ctx.store.db.query("SELECT point_id p FROM chunks WHERE point_id LIKE 'earlier#%' AND point_id NOT LIKE '%#f%' ORDER BY rowid").all() as Array<{ p: string }>).map((r) => r.p)
    const hits = new Map([["earlier", new Set([low[low.length - 1]])]])
    const { text } = await gatherMemory(ctx, "unrelated words entirely", ["earlier"], { rounds: 1, hits })
    const chunk = (ctx.store.db.query("SELECT content c FROM chunks WHERE point_id = ?").get(low[low.length - 1]) as { c: string }).c
    expect(text).toContain(chunk.replace(/^\[[^\]]+\]\s/, ""))
  })
})
