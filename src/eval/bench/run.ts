// Runner - orchestrates a full benchmark: for each case, spin up a FRESH memory, ingest its
// history, score retrieval (Tier A), and (if a Tier-B LLM is injected) answer + judge each
// question. Tier B is a DEPENDENCY (scoreQa + llm), not an import, so the runner compiles and
// runs Tier A with no LLM, and tests inject deterministic stubs. Returns one Scorecard.

import { buildEmbeddedContext } from "../../embedded/index"
import { CrossEncoderReranker } from "../../embedded/reranker"
import type { BenchmarkDataset } from "../datasets/types"
import type { RunConfig, Scorecard, BenchLlm, ScoreQaFn, RetrievedContext } from "./types"
import { ingestCase } from "./ingest"
import { scoreRetrieval, type PerQuestionRetrieval } from "./retrieval"
import { aggregateRetrieval, computeEfficiency } from "./scorecard"

export interface RunDeps {
  scoreQa?: ScoreQaFn
  llm?: BenchLlm
}

export async function runBenchmark(dataset: BenchmarkDataset, config: RunConfig, deps: RunDeps = {}): Promise<Scorecard> {
  const cases = config.limitCases && config.limitCases > 0 ? dataset.cases.slice(0, config.limitCases) : dataset.cases
  const allRetrieved: RetrievedContext[] = []
  const allPerQ: PerQuestionRetrieval[] = []
  const fullTokensPerCase: number[] = []
  const ingestMsPerCase: number[] = []
  const retrievalMsPerQuestion: number[] = []
  // One reranker shared across cases (it caches the cross-encoder model after first load).
  const reranker = config.rerank ? new CrossEncoderReranker() : undefined

  for (const c0 of cases) {
    // Optional per-case question cap (cheap Tier-B iteration). History is always ingested
    // in full; only the number of questions SCORED is capped.
    const c = config.maxQuestions && config.maxQuestions > 0 ? { ...c0, questions: c0.questions.slice(0, config.maxQuestions) } : c0
    // Fresh, isolated memory per case - each case is an independent long history, and this
    // also proves the store starts clean (no cross-case leakage inflating recall).
    const ctx = buildEmbeddedContext({ path: ":memory:", reranker })
    // Distinct user/org ids: both are graph nodes, so identical ids would collide (the org
    // node would clobber the user node under INSERT OR REPLACE). admin ⇒ unrestricted ingest.
    const userId = "bench-user"
    const orgId = "bench-org"
    ctx.ingestor.registerUser(userId, orgId, undefined, "admin")

    const ing = await ingestCase(ctx, c, userId, orgId)
    fullTokensPerCase.push(ing.fullHistoryTokens)
    ingestMsPerCase.push(ing.ingestMs)

    const r = await scoreRetrieval(ctx, c, userId, orgId, config.k)
    if (c.questions.length) retrievalMsPerQuestion.push(r.retrievalMs / c.questions.length)
    allRetrieved.push(...r.retrieved)
    allPerQ.push(...r.perQuestion)

    ctx.store.close()
  }

  const retrieval = config.tier !== "b" ? aggregateRetrieval(allPerQ) : undefined
  const qa = config.tier !== "a" && deps.scoreQa && deps.llm ? await deps.scoreQa(allRetrieved, deps.llm) : undefined
  const efficiency = computeEfficiency(allRetrieved, fullTokensPerCase, ingestMsPerCase, retrievalMsPerQuestion)

  return { config, cases: cases.length, questions: allRetrieved.length, retrieval, qa, efficiency }
}
