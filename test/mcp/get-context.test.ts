// get_context comprehensiveness: it must return the precise typed-graph answer AND the full
// ranked recall (not short-circuit to 1-few facts), and widen for breadth queries. Regresses
// the "semantic search misses 70-80%" finding. Uses a mock backend so it's deterministic.
import { test, expect, describe } from "bun:test"
import { getContextTool } from "../../src/mcp/tools/get-context"
import { RetrievalStatus } from "../../src/types"

function mockBackend(opts: { ask?: any; snippets: string[] }) {
  const calls: { limit?: number }[] = []
  const backend: any = {
    ask: opts.ask ? async () => opts.ask : undefined,
    query: async (_q: string, limit?: number) => {
      calls.push({ limit })
      return {
        status: opts.snippets.length ? RetrievalStatus.SUCCESS : RetrievalStatus.NO_RESULTS,
        statusCode: 200,
        searchResults: opts.snippets.map((content, i) => ({
          content,
          metadata: { recordName: `Doc${i + 1}` },
        })),
      }
    },
  }
  return { backend, calls }
}

const run = (args: any, backend: any) => getContextTool.handler(args, backend).then((r) => r.content[0].text as string)

describe("get_context is comprehensive (additive, not short-circuited)", () => {
  test("returns the precise KGQA answer AND all ranked snippets", async () => {
    const { backend } = mockBackend({
      ask: { confidence: 0.9, answer: "Elon Musk founded SpaceX", facts: ["Elon Musk founded SpaceX"], citations: ["r1"], triple: {} },
      snippets: ["fact A about Elon", "fact B about Elon", "fact C about Elon", "fact D", "fact E"],
    })
    const text = await run({ query: "everything about Elon Musk" }, backend)
    expect(text).toContain("Precise answer:") // KGQA highlight present
    expect(text).toContain("Elon Musk founded SpaceX")
    // ...AND every recalled snippet is included (the old code returned ONLY the 1 KGQA fact)
    for (const s of ["fact A about Elon", "fact B about Elon", "fact C about Elon", "fact D", "fact E"]) {
      expect(text).toContain(s)
    }
    expect(text).toContain("untrusted_memory") // snippets wrapped
  })

  test("breadth queries widen the limit automatically", async () => {
    const { backend, calls } = mockBackend({ snippets: ["x"] })
    await run({ query: "list all 100XPROMPT pages" }, backend)
    expect(calls[0].limit).toBe(20) // breadth detected → 20
  })

  test("non-breadth query uses the default (no explicit limit)", async () => {
    const { backend, calls } = mockBackend({ snippets: ["x"] })
    await run({ query: "who is the CEO" }, backend)
    expect(calls[0].limit).toBeUndefined()
  })

  test("explicit limit is honored and capped at 50", async () => {
    const { backend, calls } = mockBackend({ snippets: ["x"] })
    await run({ query: "stuff", limit: 999 }, backend)
    expect(calls[0].limit).toBe(50)
  })

  test("no KGQA hit → still returns the ranked snippets", async () => {
    const { backend } = mockBackend({ snippets: ["only fact"] })
    const text = await run({ query: "tell me about X" }, backend)
    expect(text).toContain("only fact")
    expect(text).not.toContain("Precise answer:")
  })
})
