// LLM extractor (mocked endpoint - no real model needed) + graph rebuild.

import { describe, expect, test } from "bun:test"
import { LlmExtractor, HybridExtractor } from "../../src/embedded/llm-extractor"
import { DeterministicExtractor } from "../../src/embedded/extract"
import { buildEmbeddedContext } from "../../src/embedded/index"

function mockLlm(json: object): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(json) } }] }),
    }) as Response) as unknown as typeof fetch
}

describe("LlmExtractor", () => {
  test("extracts entities + relations from casual lowercase text", async () => {
    const ex = new LlmExtractor({
      endpoint: "http://local-model:8000",
      model: "sovereign",
      fetchImpl: mockLlm({
        triples: [{ subject: "user", subjectType: "PERSON", predicate: "loves", object: "Lavanya", objectType: "PERSON", confidence: 0.95 }],
      }),
    })
    const out = await ex.extract("i love lavanya")
    expect(out.entities.map((e) => e.label)).toContain("Lavanya")
    expect(out.relations).toEqual([{ from: "user", to: "lavanya", type: "loves", confidence: 0.95 }])
  })

  test("tolerates JSON wrapped in stray text / code fences", async () => {
    const ex = new LlmExtractor({
      endpoint: "http://m",
      model: "m",
      fetchImpl: (async () =>
        ({
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content:
                    '```json\n{"triples":[{"subject":"Acme","subjectType":"ORG","predicate":"is_a","object":"company","objectType":"CONCEPT"}]}\n```',
                },
              },
            ],
          }),
        }) as Response) as unknown as typeof fetch,
    })
    const out = await ex.extract("acme corp")
    expect(out.entities.map((e) => e.label)).toContain("Acme")
  })

  test("HybridExtractor merges deterministic + llm, deduped", async () => {
    const llm = new LlmExtractor({
      endpoint: "http://m",
      model: "m",
      fetchImpl: mockLlm({
        triples: [{ subject: "user", subjectType: "PERSON", predicate: "loves", object: "Lavanya", objectType: "PERSON" }],
      }),
    })
    const hy = new HybridExtractor(new DeterministicExtractor(), llm)
    const out = await hy.extract("100X Prompt Pro. i love lavanya")
    const labels = out.entities.map((e) => e.label)
    expect(labels).toContain("100X Prompt Pro") // from deterministic
    expect(labels).toContain("Lavanya") // from llm
  })
})

describe("rebuildGraph", () => {
  test("re-extracts the concept graph for existing records", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o")
    // ingest WITHOUT extraction (simulates data from before extraction existed)
    await ctx.ingestor.ingest({
      recordId: "doc",
      orgId: "o",
      recordName: "Doc",
      text: "100X Prompt Pro and 100X Prompt Flash are Sovereign Models.",
      permittedPrincipals: ["u"],
      extractGraph: false,
    })
    let g = ctx.graph.getKnowledgeGraph(["doc"])
    expect(g.entities.length).toBe(0) // none yet

    const res = await ctx.rebuildGraph()
    expect(res.entities).toBeGreaterThan(0)
    g = ctx.graph.getKnowledgeGraph(["doc"])
    expect(g.entities.map((e) => e.label)).toContain("100X Prompt Pro")
  })
})
