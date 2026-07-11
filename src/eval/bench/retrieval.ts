// Tier A - RETRIEVAL scoring. The cheap, deterministic, no-LLM half: for each question, run
// Chitta's hybrid retriever and ask whether the gold-evidence record(s) came back in the
// top-k (recall@k / nDCG@k / MRR / P@k via the shared metrics.ts). This isolates "is the
// MEMORY surfacing the right thing", separate from "can an LLM answer from it" (Tier B) - so
// a low end-to-end score can be attributed to retrieval vs generation. Abstention questions
// have no gold evidence, so they're carried through for Tier B but excluded from recall here.

import type { EmbeddedContext } from "../../embedded/index"
import type { BenchmarkCase, QuestionCategory } from "../datasets/types"
import { recallAtK, precisionAtK, reciprocalRank, ndcgAtK } from "../metrics"
import { approxTokens, type RetrievedContext } from "./types"

export interface PerQuestionRetrieval {
  category: QuestionCategory
  abstain: boolean
  recall: number
  precision: number
  ndcg: number
  mrr: number
}

export async function scoreRetrieval(
  ctx: EmbeddedContext,
  c: BenchmarkCase,
  userId: string,
  orgId: string,
  k: number,
): Promise<{ retrieved: RetrievedContext[]; perQuestion: PerQuestionRetrieval[]; retrievalMs: number }> {
  const retrieved: RetrievedContext[] = []
  const perQuestion: PerQuestionRetrieval[] = []
  let retrievalMs = 0

  for (const q of c.questions) {
    const t0 = performance.now()
    const res = await ctx.searchWithGraph(q.question, userId, orgId, undefined, k)
    retrievalMs += performance.now() - t0

    // Record-level ranked list (a record can yield several snippets - keep each record's
    // FIRST appearance, so metrics don't double-count).
    const seen = new Set<string>()
    const ranked: string[] = []
    for (const r of res.searchResults) {
      const id = (r.metadata as { recordId?: string }).recordId
      if (id && !seen.has(id)) {
        seen.add(id)
        ranked.push(id)
      }
    }
    // The exact text an answer LLM would be handed (Tier B) - so token counts are honest.
    const contextText = res.searchResults.map((r) => r.content).join("\n\n")
    retrieved.push({ question: q, rankedRecordIds: ranked, contextText, contextTokens: approxTokens(contextText) })

    if (q.abstain) {
      perQuestion.push({ category: q.category, abstain: true, recall: 0, precision: 0, ndcg: 0, mrr: 0 })
      continue
    }
    const gold = new Set(q.evidenceIds)
    perQuestion.push({
      category: q.category,
      abstain: false,
      recall: recallAtK(ranked, gold, k),
      precision: precisionAtK(ranked, gold, k),
      ndcg: ndcgAtK(ranked, gold, k),
      mrr: reciprocalRank(ranked, gold),
    })
  }
  return { retrieved, perQuestion, retrievalMs }
}
