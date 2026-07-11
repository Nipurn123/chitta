// Tier-B QA scorer + HTTP client tests. Fully deterministic - no real network. The
// scoreQa tests inject a stub BenchLlm whose `answer` returns the gold fact only when a
// keyword for it appears in the context (else the "I don't know" sentinel), and whose
// `judge` is a normalized substring match. The HttpBenchLlm tests inject a fake `fetch`
// that returns canned chat-completions, proving the request wiring and CORRECT/INCORRECT
// parsing without a model.

import { test, expect, describe } from "bun:test"
import { scoreQa } from "../../src/eval/bench/qa"
import { HttpBenchLlm, httpBenchLlmFromEnv } from "../../src/eval/bench/llm"
import { approxTokens } from "../../src/eval/bench/types"
import type { BenchLlm, RetrievedContext } from "../../src/eval/bench/types"
import type { BenchQuestion, QuestionCategory } from "../../src/eval/datasets/types"

// --- deterministic stub LLM -------------------------------------------------

class StubLlm implements BenchLlm {
  constructor(private readonly facts: Array<{ keyword: string; answer: string }>) {}

  // Return the gold answer if its keyword is present in the context, else abstain.
  async answer(_question: string, context: string): Promise<string> {
    const c = context.toLowerCase()
    for (const f of this.facts) {
      if (f.keyword && c.includes(f.keyword.toLowerCase())) return f.answer
    }
    return "I don't know"
  }

  // Substring / normalized-equality match stands in for semantic judging.
  async judge(_question: string, gold: string, predicted: string): Promise<boolean> {
    const norm = (s: string) =>
      s
        .toLowerCase()
        .replace(/['’`]/g, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    const g = norm(gold)
    const p = norm(predicted)
    if (!g || !p) return false
    return p === g || p.includes(g) || g.includes(p)
  }
}

// --- helpers ----------------------------------------------------------------

function q(
  id: string,
  question: string,
  answer: string,
  category: QuestionCategory,
  opts: { evidenceIds?: string[]; abstain?: boolean } = {},
): BenchQuestion {
  return { id, question, answer, category, evidenceIds: opts.evidenceIds ?? [], abstain: opts.abstain }
}

function ctx(question: BenchQuestion, contextText: string, rankedRecordIds: string[] = []): RetrievedContext {
  return { question, rankedRecordIds, contextText, contextTokens: approxTokens(contextText) }
}

const stub = () =>
  new StubLlm([
    { keyword: "france", answer: "Paris" },
    { keyword: "germany", answer: "Berlin" },
    { keyword: "acme", answer: "2019" },
  ])

// --- scoreQa: the three required per-question behaviors ----------------------

describe("scoreQa per-question correctness", () => {
  test("normal question with the evidence in context scores CORRECT", async () => {
    const rows = await scoreQa(
      [ctx(q("q1", "What is the capital of France?", "Paris", "single-hop", { evidenceIds: ["e1"] }), "The capital of France is Paris.", ["e1"])],
      stub(),
    )
    const overall = rows.find((r) => r.category === "overall")!
    expect(overall.n).toBe(1)
    expect(overall.correct).toBe(1)
    expect(overall.accuracy).toBe(1)
  })

  test("normal question with empty context scores INCORRECT (model abstained, gold expected)", async () => {
    const rows = await scoreQa(
      [ctx(q("q2", "What is the capital of Germany?", "Berlin", "single-hop", { evidenceIds: ["e2"] }), "")],
      stub(),
    )
    const overall = rows.find((r) => r.category === "overall")!
    expect(overall.n).toBe(1)
    expect(overall.correct).toBe(0)
    expect(overall.accuracy).toBe(0)
  })

  test("abstention question with empty context scores CORRECT (model said 'I don't know')", async () => {
    const rows = await scoreQa(
      [ctx(q("q3", "What is the user's blood type?", "", "abstention", { abstain: true }), "")],
      stub(),
    )
    const row = rows.find((r) => r.category === "abstention")!
    expect(row.n).toBe(1)
    expect(row.correct).toBe(1)
    expect(row.accuracy).toBe(1)
  })
})

// --- scoreQa: per-category + overall aggregation ----------------------------

describe("scoreQa aggregation", () => {
  test("computes per-category accuracy and an overall row that aggregates them", async () => {
    const retrieved: RetrievedContext[] = [
      // single-hop: one right, one wrong -> 0.5
      ctx(q("s1", "Capital of France?", "Paris", "single-hop", { evidenceIds: ["e1"] }), "France's capital is Paris.", ["e1"]),
      ctx(q("s2", "Capital of Germany?", "Berlin", "single-hop", { evidenceIds: ["e2"] }), ""),
      // multi-hop: right -> 1.0
      ctx(q("m1", "When was Acme founded?", "2019", "multi-hop", { evidenceIds: ["e3"] }), "Acme was founded in 2019.", ["e3"]),
      // abstention: correctly refuses -> 1.0
      ctx(q("a1", "What is the user's SSN?", "", "abstention", { abstain: true }), ""),
    ]

    const rows = await scoreQa(retrieved, stub())

    const single = rows.find((r) => r.category === "single-hop")!
    const multi = rows.find((r) => r.category === "multi-hop")!
    const abstain = rows.find((r) => r.category === "abstention")!
    const overall = rows.find((r) => r.category === "overall")!

    expect(single).toMatchObject({ n: 2, correct: 1 })
    expect(single.accuracy).toBeCloseTo(0.5, 10)
    expect(multi).toMatchObject({ n: 1, correct: 1, accuracy: 1 })
    expect(abstain).toMatchObject({ n: 1, correct: 1, accuracy: 1 })

    // overall aggregates every category: n and correct are the sums.
    const categories = rows.filter((r) => r.category !== "overall")
    expect(overall.n).toBe(categories.reduce((s, r) => s + r.n, 0)) // 2 + 1 + 1 = 4
    expect(overall.correct).toBe(categories.reduce((s, r) => s + r.correct, 0)) // 1 + 1 + 1 = 3
    expect(overall.n).toBe(4)
    expect(overall.correct).toBe(3)
    expect(overall.accuracy).toBeCloseTo(0.75, 10)

    // overall is present exactly once and comes last.
    expect(rows.filter((r) => r.category === "overall").length).toBe(1)
    expect(rows[rows.length - 1]!.category).toBe("overall")
  })

  test("empty input yields a single overall row with zero accuracy", async () => {
    const rows = await scoreQa([], stub())
    expect(rows).toEqual([{ category: "overall", n: 0, correct: 0, accuracy: 0 }])
  })

  test("an LLM that throws counts as incorrect, not a crash", async () => {
    const boom: BenchLlm = {
      answer: async () => {
        throw new Error("endpoint down")
      },
      judge: async () => {
        throw new Error("endpoint down")
      },
    }
    const rows = await scoreQa(
      [ctx(q("b1", "Capital of France?", "Paris", "single-hop", { evidenceIds: ["e1"] }), "France's capital is Paris.", ["e1"])],
      boom,
    )
    const overall = rows.find((r) => r.category === "overall")!
    expect(overall).toMatchObject({ n: 1, correct: 0, accuracy: 0 })
  })
})

// --- HttpBenchLlm: wiring + parsing with a fake fetch (no network) -----------

function fakeFetch(reply: string, capture?: (url: string, init: RequestInit) => void): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    capture?.(String(input), init ?? {})
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
}

describe("HttpBenchLlm", () => {
  test("answer() posts to /v1/chat/completions with auth + model and returns trimmed text", async () => {
    let url = ""
    let init: RequestInit = {}
    const llm = new HttpBenchLlm({
      endpoint: "http://localhost:8000/", // trailing slash must be normalized away
      answerModel: "answer-model",
      judgeModel: "judge-model",
      apiKey: "sk-test",
      fetchImpl: fakeFetch("  Paris  ", (u, i) => {
        url = u
        init = i
      }),
    })

    const out = await llm.answer("Capital of France?", "France's capital is Paris.")
    expect(out).toBe("Paris") // trimmed

    expect(url).toBe("http://localhost:8000/v1/chat/completions")
    const headers = init.headers as Record<string, string>
    expect(headers["content-type"]).toBe("application/json")
    expect(headers.authorization).toBe("Bearer sk-test")
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe("answer-model")
    expect(body.temperature).toBe(0)
    expect(body.messages[0].role).toBe("system")
    expect(body.messages[1].content).toContain("France's capital is Paris.")
  })

  test("answer() omits the auth header when no apiKey is set", async () => {
    let init: RequestInit = {}
    const llm = new HttpBenchLlm({
      endpoint: "http://localhost:8000",
      fetchImpl: fakeFetch("ok", (_u, i) => {
        init = i
      }),
    })
    await llm.answer("q", "c")
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBeUndefined()
  })

  test("judge() parses CORRECT -> true and INCORRECT -> false, uses the judge model", async () => {
    let init: RequestInit = {}
    const yes = new HttpBenchLlm({
      endpoint: "http://x",
      judgeModel: "judge-model",
      fetchImpl: fakeFetch("CORRECT", (_u, i) => {
        init = i
      }),
    })
    expect(await yes.judge("q", "Paris", "the city of Paris")).toBe(true)
    expect(JSON.parse(init.body as string).model).toBe("judge-model")

    const no = new HttpBenchLlm({ endpoint: "http://x", fetchImpl: fakeFetch("INCORRECT") })
    expect(await no.judge("q", "Paris", "London")).toBe(false)

    // Robust to extra words around the verdict.
    const verbose = new HttpBenchLlm({ endpoint: "http://x", fetchImpl: fakeFetch("Verdict: CORRECT.") })
    expect(await verbose.judge("q", "Paris", "Paris")).toBe(true)
  })
})

// --- factory ----------------------------------------------------------------

describe("httpBenchLlmFromEnv", () => {
  test("returns null when CONTEXT_LLM_URL is unset", () => {
    const saved = process.env.CONTEXT_LLM_URL
    delete process.env.CONTEXT_LLM_URL
    try {
      expect(httpBenchLlmFromEnv()).toBeNull()
    } finally {
      if (saved !== undefined) process.env.CONTEXT_LLM_URL = saved
    }
  })

  test("builds a client when CONTEXT_LLM_URL is set", () => {
    const saved = process.env.CONTEXT_LLM_URL
    process.env.CONTEXT_LLM_URL = "http://localhost:9999"
    try {
      expect(httpBenchLlmFromEnv()).toBeInstanceOf(HttpBenchLlm)
    } finally {
      if (saved === undefined) delete process.env.CONTEXT_LLM_URL
      else process.env.CONTEXT_LLM_URL = saved
    }
  })
})
