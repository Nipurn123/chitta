// Tier-B scorer: end-to-end QA accuracy over the contexts Tier-A retrieval produced.
// For each question we hand the answer model ONLY its retrieved context and check the
// answer:
//   - abstention questions (the answer isn't in memory) are correct iff the model
//     REFUSES - it emitted the "I don't know" sentinel or an equivalent refusal.
//   - every other question is correct iff the LLM judge rules the prediction
//     semantically equal to the gold answer (paraphrase-tolerant).
// Results roll up to one row per QuestionCategory present plus an "overall" row, so a
// scorecard shows WHICH kind of memory reasoning the system answers well, not one
// blended number.
//
// The LLM is injected, so any single call throwing (a flaky endpoint) is caught and
// counted as an incorrect answer rather than aborting the whole run.

import type { BenchLlm, QaHooks, QaScore, RetrievedContext, ScoreQaFn } from "./types"
import type { BenchQuestion, QuestionCategory } from "../datasets/types"

// Canonical category order for stable, readable rows (values, not the type union).
const CATEGORY_ORDER: readonly QuestionCategory[] = [
  "single-hop",
  "multi-hop",
  "temporal",
  "knowledge-update",
  "abstention",
  "open-domain",
]

function categoryRank(c: QuestionCategory): number {
  const i = CATEGORY_ORDER.indexOf(c)
  return i < 0 ? CATEGORY_ORDER.length : i // unknown categories sort last, deterministically
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’`]/g, "") // don't -> dont (so the sentinel matches after stripping)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

// Refusal phrasings that count as "the model abstained". The exact sentinel the answer
// prompt asks for ("I don't know") is first; the rest catch models that refuse in their
// own words. Only ever consulted for abstention questions, where ANY refusal is correct.
const DONT_KNOW_PATTERNS = [
  "i dont know",
  "dont know",
  "i do not know",
  "do not know",
  "not sure",
  "cannot determine",
  "cant determine",
  "cannot answer",
  "cant answer",
  "unable to answer",
  "unable to determine",
  "no information",
  "not enough information",
  "insufficient information",
  "not in the context",
  "not in the provided context",
  "not mentioned",
  "not stated",
  "not specified",
  "not provided",
  "not available",
  "no mention",
  "no answer",
  "unknown",
]

function expressesDontKnow(text: string): boolean {
  const t = normalize(text)
  if (!t) return true // an empty answer is the model declining to answer
  return DONT_KNOW_PATTERNS.some((p) => t.includes(p))
}

async function isCorrect(q: BenchQuestion, contextText: string, llm: BenchLlm): Promise<{ correct: boolean; predicted: string }> {
  let predicted: string
  try {
    predicted = await llm.answer(q.question, contextText, { questionDate: q.questionDate })
  } catch {
    return { correct: false, predicted: "" } // a thrown answer counts as wrong, not a crashed run
  }

  return { correct: await judgePrediction(q, predicted, llm), predicted }
}

/** Grade one prediction for a question. `abstain` and the `abstention` category both mean "the
 *  answer isn't in memory": a dataset with its own question types (LongMemEval) is graded by the
 *  judge with its abstention rule, as its official scorer does; otherwise any refusal phrasing
 *  counts. Everything else: the judge decides semantic correctness by the question type's rule. */
export async function judgePrediction(q: BenchQuestion, predicted: string, llm: BenchLlm, opts: { rethrow?: boolean } = {}): Promise<boolean> {
  const abstention = q.abstain === true || q.category === "abstention"
  if (abstention && !q.sourceType) return expressesDontKnow(predicted)
  try {
    return await llm.judge(q.question, q.answer, predicted, { questionType: q.sourceType, abstention })
  } catch (e) {
    if (opts.rethrow) throw e // the caller wants "no grade" kept apart from "wrong"
    return false
  }
}

export const scoreQa: ScoreQaFn = async (retrieved: RetrievedContext[], llm: BenchLlm, hooks?: QaHooks): Promise<QaScore[]> => {
  const perCategory = new Map<QuestionCategory, { n: number; correct: number }>()
  let overallN = 0
  let overallCorrect = 0

  // Answer + judge `concurrency` questions at a time (default 1); aggregation below is in input
  // order either way, so the result doesn't depend on the concurrency.
  const results = new Array<{ correct: boolean; predicted: string }>(retrieved.length)
  let next = 0
  const worker = async () => {
    while (next < retrieved.length) {
      const i = next++
      results[i] = await isCorrect(retrieved[i].question, retrieved[i].contextText, llm)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, hooks?.concurrency ?? 1) }, worker))

  for (const [i, rc] of retrieved.entries()) {
    const { correct, predicted } = results[i]
    hooks?.onAnswer?.(rc.question, predicted, correct)
    const bucket = perCategory.get(rc.question.category) ?? { n: 0, correct: 0 }
    bucket.n += 1
    if (correct) bucket.correct += 1
    perCategory.set(rc.question.category, bucket)
    overallN += 1
    if (correct) overallCorrect += 1
  }

  const rows: QaScore[] = [...perCategory.entries()]
    .sort(([a], [b]) => categoryRank(a) - categoryRank(b))
    .map(([category, { n, correct }]) => ({ category, n, correct, accuracy: n ? correct / n : 0 }))

  // "overall" always present - it aggregates every category's n and correct.
  rows.push({
    category: "overall",
    n: overallN,
    correct: overallCorrect,
    accuracy: overallN ? overallCorrect / overallN : 0,
  })

  return rows
}
