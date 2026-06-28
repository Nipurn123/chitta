// get_context comprehensiveness: it must return the precise typed-graph answer AND the full
// ranked recall (not short-circuit to 1-few facts), and widen for breadth queries. Regresses
// the "semantic search misses 70-80%" finding. Uses a mock backend so it's deterministic.
import { test, expect, describe } from "bun:test"
import { getContextTool } from "../../src/mcp/tools/get-context"
import { RetrievalStatus } from "../../src/types"

function mockBackend(opts: { ask?: any; snippets: string[]; relatedFacts?: { entity: string; facts: string[] } | null }) {
  const calls: { limit?: number }[] = []
  const relCalls: { limit?: number }[] = []
  const backend: any = {
    ask: opts.ask ? async () => opts.ask : undefined,
    relatedFacts:
      "relatedFacts" in opts
        ? async (_q: string, limit?: number) => {
            relCalls.push({ limit })
            return opts.relatedFacts ?? null
          }
        : undefined,
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
  return { backend, calls, relCalls }
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

  test("breadth query folds in the FULL typed-graph neighborhood (closes the completeness gap)", async () => {
    // ranked retrieval misses graph neighbors that aren't lexically/semantically close;
    // the graph-facts section adds the complete edge set, like context_relate.
    const { backend, relCalls } = mockBackend({
      snippets: ["Elon Musk founded SpaceX"], // ranked recall only surfaces the obvious one
      relatedFacts: {
        entity: "Elon Musk",
        facts: ["Elon Musk founded X Corp", "Elon Musk leads DOGE", "Elon Musk dated Grimes", "Elon Musk is parent of Vivian Wilson"],
      },
    })
    const text = await run({ query: "tell me everything about Elon Musk" }, backend)
    expect(text).toContain("Related facts about Elon Musk")
    for (const f of ["X Corp", "DOGE", "Grimes", "Vivian Wilson"]) expect(text).toContain(f)
    expect(relCalls[0].limit).toBe(20) // breadth limit threaded into the neighborhood call
  })

  test("narrow factual query with a KGQA hit does NOT dump the whole neighborhood", async () => {
    const { backend, relCalls } = mockBackend({
      ask: { confidence: 0.9, answer: "Sarah Chen works at Google", facts: ["Sarah Chen works at Google"], citations: [], triple: {} },
      snippets: ["x"],
      relatedFacts: { entity: "Sarah Chen", facts: ["Sarah Chen likes coffee"] },
    })
    const text = await run({ query: "where does Sarah Chen work" }, backend)
    expect(text).toContain("Precise answer:")
    expect(text).not.toContain("Related facts about") // gated off for focused queries with a precise hit
    expect(relCalls.length).toBe(0) // not even called
  })

  test("narrow query with NO KGQA hit still gets the neighborhood (rescue path)", async () => {
    const { backend } = mockBackend({
      snippets: ["x"],
      relatedFacts: { entity: "Acme", facts: ["Acme builds AI", "Acme competes with Globex"] },
    })
    const text = await run({ query: "what about Acme" }, backend)
    expect(text).toContain("Related facts about Acme")
    expect(text).toContain("Globex")
  })
})
