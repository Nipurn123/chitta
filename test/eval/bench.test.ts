// Benchmark framework spine - proves the runner produces a valid scorecard on the built-in
// synthetic dataset. Tier A runs for real (deterministic under the pinned hash embedder);
// Tier B is exercised via an INJECTED stub LLM + scoreQa (the DI seam), so the whole
// framework is validated end to end with no network.

import { test, expect, describe } from "bun:test"
import { runBenchmark } from "../../src/eval/bench/run"
import { syntheticDataset } from "../../src/eval/datasets/synthetic"
import type { ScoreQaFn, BenchLlm, QaScore } from "../../src/eval/bench/types"

// Deterministic stub LLM: "answers" by returning the retrieved context (or "I don't know"
// when nothing was retrieved), and "judges" by checking the gold's key term is present.
const stubLlm: BenchLlm = {
  async answer(_q, context) {
    return context.trim() ? context : "I don't know"
  },
  async judge(_q, gold, predicted) {
    const key = gold.toLowerCase().split(/\s+/).filter(Boolean).pop() ?? gold.toLowerCase()
    return predicted.toLowerCase().includes(key)
  },
}

// Minimal ScoreQaFn mirroring the real qa.ts contract (per-category + overall accuracy),
// so the runner's Tier-B wiring is validated without importing the LLM module.
const stubScoreQa: ScoreQaFn = async (retrieved, llm) => {
  const cat = new Map<string, { n: number; correct: number }>()
  for (const r of retrieved) {
    const pred = await llm.answer(r.question.question, r.contextText)
    const ok = r.question.abstain ? /don't know/i.test(pred) : await llm.judge(r.question.question, r.question.answer, pred)
    const e = cat.get(r.question.category) ?? { n: 0, correct: 0 }
    e.n++
    if (ok) e.correct++
    cat.set(r.question.category, e)
  }
  const rows: QaScore[] = [...cat.entries()].map(([category, e]) => ({ category: category as QaScore["category"], n: e.n, correct: e.correct, accuracy: e.correct / e.n }))
  const n = retrieved.length
  const correct = rows.reduce((a, b) => a + b.correct, 0)
  return [{ category: "overall", n, correct, accuracy: n ? correct / n : 0 }, ...rows]
}

describe("benchmark framework", () => {
  test("Tier A produces per-category retrieval metrics + efficiency on the synthetic dataset", async () => {
    const card = await runBenchmark(syntheticDataset, { dataset: "synthetic", tier: "a", k: 5, embedder: "hash" })
    expect(card.cases).toBe(2)
    expect(card.questions).toBe(11)
    expect(card.retrieval).toBeDefined()
    const overall = card.retrieval!.find((r) => r.category === "overall")!
    expect(overall.n).toBe(10) // 11 questions - 1 abstention (excluded from recall)
    expect(overall.recall).toBeGreaterThan(0.5) // distinctive tokens → hybrid nails most
    // the categories Chitta was built for are present + measured on their own
    expect(card.retrieval!.some((r) => r.category === "knowledge-update")).toBe(true)
    expect(card.retrieval!.some((r) => r.category === "temporal")).toBe(true)
    // retrieval feeds the answer LLM a SLICE, not the whole history
    expect(card.efficiency.tokenReductionX).toBeGreaterThan(1)
    expect(card.qa).toBeUndefined() // Tier A only
  })

  test("Tier B runs via injected scoreQa + stub LLM and aggregates accuracy", async () => {
    const card = await runBenchmark(
      syntheticDataset,
      { dataset: "synthetic", tier: "both", k: 5, embedder: "hash", answerModel: "stub", judgeModel: "stub" },
      { scoreQa: stubScoreQa, llm: stubLlm },
    )
    expect(card.qa).toBeDefined()
    const overall = card.qa!.find((r) => r.category === "overall")!
    expect(overall.n).toBe(card.questions)
    expect(overall.accuracy).toBeGreaterThanOrEqual(0)
    expect(overall.accuracy).toBeLessThanOrEqual(1)
    // the abstention question flows through Tier B and gets its own scored category row
    const abst = card.qa!.find((r) => r.category === "abstention")
    expect(abst?.n).toBe(1)
  })
})
