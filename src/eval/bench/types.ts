// Benchmark run contracts - config, per-category scores, the scorecard, and the injectable
// Tier-B LLM. FROZEN so the QA/judge module (Tier B) and the runner (spine) can be built
// independently: the runner takes `scoreQa` + `llm` as DEPENDENCIES rather than importing
// them, so it needs no LLM to compile or to run Tier A, and tests inject stubs.

import type { QuestionCategory, BenchQuestion } from "../datasets/types"

export interface RunConfig {
  dataset: string
  tier: "a" | "b" | "both"
  /** top-k retrieved records scored per question. */
  k: number
  /** cap on cases (subset iteration). */
  limitCases?: number
  /** reported for reproducibility - a benchmark number is meaningless without its config. */
  embedder: string
  answerModel?: string
  judgeModel?: string
}

/** Aggregate retrieval metrics for one category (or "overall"). */
export interface RetrievalScore {
  category: QuestionCategory | "overall"
  n: number
  recall: number
  ndcg: number
  mrr: number
  precision: number
}

/** Aggregate end-to-end QA accuracy for one category (or "overall"). */
export interface QaScore {
  category: QuestionCategory | "overall"
  n: number
  correct: number
  accuracy: number
}

/** The efficiency story: retrieval feeds the answer LLM only the RELEVANT slice, not the
 *  whole history. `tokenReductionX` = full-history tokens / retrieved-context tokens. */
export interface EfficiencyStats {
  avgContextTokens: number
  avgFullHistoryTokens: number
  tokenReductionX: number
  avgIngestMs: number
  avgRetrievalMs: number
}

export interface Scorecard {
  config: RunConfig
  cases: number
  questions: number
  /** overall + per-category (Tier A). */
  retrieval?: RetrievalScore[]
  /** overall + per-category (Tier B). */
  qa?: QaScore[]
  efficiency: EfficiencyStats
}

/** What one question produced at retrieval time - the bridge from Tier A to Tier B. The
 *  `contextText` is EXACTLY what an answer LLM would be given (so token counts are honest). */
export interface RetrievedContext {
  question: BenchQuestion
  rankedRecordIds: string[]
  contextText: string
  contextTokens: number
}

/** Tier-B LLM, injectable: an HTTP OpenAI-compatible client in production, a deterministic
 *  stub in tests. `answer` responds to the question FROM the retrieved context only;
 *  `judge` decides whether a prediction matches the gold answer (LLM-as-judge). */
export interface BenchLlm {
  answer(question: string, context: string): Promise<string>
  judge(question: string, gold: string, predicted: string): Promise<boolean>
}

/** Score Tier B over the retrieved contexts with the given LLM → per-category + overall
 *  accuracy. Implemented in bench/qa.ts; injected into the runner so the spine has no hard
 *  dependency on the LLM path. */
export type ScoreQaFn = (retrieved: RetrievedContext[], llm: BenchLlm) => Promise<QaScore[]>

/** Rough token estimate (≈ chars/4, the standard GPT heuristic) - dependency-free, good
 *  enough for the reduction ratio + budgeting. Shared so every module counts identically. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
