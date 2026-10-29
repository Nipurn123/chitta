// Fact keys: caller- or LLM-supplied facts become extra, dated, ACL-scoped search keys of their record.
import { test, expect, describe } from "bun:test"
import { buildEmbeddedContext } from "../../src/embedded/index"
import { LlmExtractor } from "../../src/embedded/llm-extractor"
import { datedPassage } from "../../src/embedded/retrieval/passage"

const fakeFetch = (reply: string) =>
  (async () => new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), { status: 200 })) as unknown as typeof fetch

describe("fact keys", () => {
  test("caller facts are stored as dated chunks of the record and found by search; other users can't see them", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o", "u@x.com", "admin")
    ctx.ingestor.registerUser("eve", "o", "e@x.com", "editor")
    await ctx.authorizedIngest("u", {
      recordId: "chat1", orgId: "o", recordName: "chat", permittedPrincipals: ["u"], occurredAt: "2024-03-01",
      text: "user: we talked about weekend plans and the weather mostly\nassistant: sounds fun",
      facts: ["The user adopted a beagle named Max."],
    })
    const row = ctx.store.db.query("SELECT content FROM chunks WHERE point_id = 'chat1#f0'").get() as { content: string }
    expect(row.content).toBe("[2024-03-01] The user adopted a beagle named Max.")
    const mine = await ctx.searchWithGraph("what dog breed did I adopt", "u", "o")
    expect(mine.searchResults.some((r) => r.metadata.recordId === "chat1")).toBe(true)
    const theirs = await ctx.searchWithGraph("what dog breed did I adopt", "eve", "o")
    expect(theirs.searchResults.some((r) => r.metadata.recordId === "chat1")).toBe(false) // inherits the record ACL
  })

  test("extractFacts parses a JSON array (code fences tolerated), else returns []", async () => {
    const ok = new LlmExtractor({ endpoint: "http://x", model: "m", fetchImpl: fakeFetch('```json\n["The user lives in Pune.", 7]\n```') })
    expect(await ok.extractFacts("text", "2024-03-01")).toEqual(["The user lives in Pune."])
    const bad = new LlmExtractor({ endpoint: "http://x", model: "m", fetchImpl: fakeFetch("no facts here") })
    expect(await bad.extractFacts("text")).toEqual([])
  })

  test("a returned passage keeps its chunk's date header", () => {
    expect(datedPassage("[2024-03-01] user: hi\nassistant: I got a beagle", "assistant: I got a beagle")).toBe("[2024-03-01] assistant: I got a beagle")
    expect(datedPassage("(2023/05/20 (Sat) 02:21): user: hi\nassistant: ok", "assistant: ok")).toBe("[2023/05/20 (Sat) 02:21] assistant: ok")
    expect(datedPassage("no header here", "no header here")).toBe("no header here")
  })
})

describe("SDK remember forwards facts + occurredAt", () => {
  test("a fact passed to remember() is searchable and dated", async () => {
    const { Chitta } = await import("../../src/sdk")
    const mem = new Chitta({ embeddings: "hash", rerank: false })
    const { id } = await mem.remember("we chatted about the weekend", { facts: ["The user's favourite tea is oolong."], occurredAt: "2024-03-01" })
    const row = mem.ctx.store.db.query("SELECT content FROM chunks WHERE point_id = ?").get(`${id}#f0`) as { content: string }
    expect(row.content).toBe("[2024-03-01] The user's favourite tea is oolong.")
  })
})
