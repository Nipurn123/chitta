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

import type { BenchLlm, QaScore, RetrievedContext, ScoreQaFn } from "./types"
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

async function isCorrect(q: BenchQuestion, contextText: string, llm: BenchLlm): Promise<boolean> {
  let predicted: string
  try {
    predicted = await llm.answer(q.question, contextText)
  } catch {
    return false // a thrown answer counts as wrong, not a crashed run
  }

  // `abstain` and the `abstention` category both mean "the answer isn't in memory".
  if (q.abstain === true || q.category === "abstention") {
    return expressesDontKnow(predicted)
  }

  // Normal question: the judge decides semantic correctness (paraphrase-aware).
  try {
    return await llm.judge(q.question, q.answer, predicted)
  } catch {
    return false
  }
}

export const scoreQa: ScoreQaFn = async (retrieved: RetrievedContext[], llm: BenchLlm): Promise<QaScore[]> => {
  const perCategory = new Map<QuestionCategory, { n: number; correct: number }>()
  let overallN = 0
  let overallCorrect = 0

  for (const rc of retrieved) {
    const correct = await isCorrect(rc.question, rc.contextText, llm)
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
