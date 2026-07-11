// Scorecard - aggregate per-question results into per-category + overall scores, and render
// them (console table / markdown / json). The category breakdown is the payload: it shows
// WHICH kind of memory reasoning is strong or weak, not one blended number. Every scorecard
// carries its RunConfig, because a benchmark number without its config (embedder, k, model)
// is not reproducible and not comparable.

import type { RetrievalScore, QaScore, EfficiencyStats, Scorecard } from "./types"
import type { PerQuestionRetrieval } from "./retrieval"
import type { RetrievedContext } from "./types"

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const meanBy = <T>(xs: T[], f: (x: T) => number): number => mean(xs.map(f))

/** Overall + per-category retrieval metrics (abstention questions excluded - no gold to hit). */
export function aggregateRetrieval(per: PerQuestionRetrieval[]): RetrievalScore[] {
  const scored = per.filter((p) => !p.abstain)
  const cats = [...new Set(scored.map((p) => p.category))]
  const row = (category: RetrievalScore["category"], s: PerQuestionRetrieval[]): RetrievalScore => ({
    category,
    n: s.length,
    recall: meanBy(s, (p) => p.recall),
    ndcg: meanBy(s, (p) => p.ndcg),
    mrr: meanBy(s, (p) => p.mrr),
    precision: meanBy(s, (p) => p.precision),
  })
  return [row("overall", scored), ...cats.map((c) => row(c, scored.filter((p) => p.category === c)))]
}

export function computeEfficiency(
  retrieved: RetrievedContext[],
  fullTokensPerCase: number[],
  ingestMsPerCase: number[],
  retrievalMsPerQuestion: number[],
): EfficiencyStats {
  const avgContextTokens = meanBy(retrieved, (r) => r.contextTokens)
  const avgFullHistoryTokens = mean(fullTokensPerCase)
  return {
    avgContextTokens,
    avgFullHistoryTokens,
    tokenReductionX: avgContextTokens > 0 ? avgFullHistoryTokens / avgContextTokens : 0,
    avgIngestMs: mean(ingestMsPerCase),
    avgRetrievalMs: mean(retrievalMsPerQuestion),
  }
}

// ── rendering ────────────────────────────────────────────────────────────────
const f3 = (n: number) => n.toFixed(3)
const pad = (s: string, w: number) => (s.length >= w ? s : s + " ".repeat(w - s.length))
const padL = (s: string, w: number) => (s.length >= w ? s : " ".repeat(w - s.length) + s)

function retrievalTable(rows: RetrievalScore[]): string {
  const head = `  ${pad("category", 18)}${padL("n", 4)}  ${padL("recall", 7)}  ${padL("nDCG", 6)}  ${padL("MRR", 6)}  ${padL("P", 6)}`
  const body = rows.map(
    (r) => `  ${pad(r.category, 18)}${padL(String(r.n), 4)}  ${padL(f3(r.recall), 7)}  ${padL(f3(r.ndcg), 6)}  ${padL(f3(r.mrr), 6)}  ${padL(f3(r.precision), 6)}`,
  )
  return [head, ...body].join("\n")
}

function qaTable(rows: QaScore[]): string {
  const head = `  ${pad("category", 18)}${padL("n", 4)}  ${padL("correct", 8)}  ${padL("accuracy", 9)}`
  const body = rows.map((r) => `  ${pad(r.category, 18)}${padL(String(r.n), 4)}  ${padL(String(r.correct), 8)}  ${padL(f3(r.accuracy), 9)}`)
  return [head, ...body].join("\n")
}

/** Human-readable console scorecard. */
export function renderScorecard(card: Scorecard): string {
  const c = card.config
  const e = card.efficiency
  const lines = [
    `Chitta benchmark — ${c.dataset}`,
    `  config       tier=${c.tier}  k=${c.k}  embedder=${c.embedder}  rerank=${c.rerank ? "on" : "off"}${c.answerModel ? `  answer=${c.answerModel}` : ""}${c.judgeModel ? `  judge=${c.judgeModel}` : ""}`,
    `  scope        ${card.cases} case(s), ${card.questions} question(s)`,
    "",
  ]
  if (card.retrieval) lines.push("Tier A — retrieval", retrievalTable(card.retrieval), "")
  if (card.qa) lines.push("Tier B — end-to-end QA (LLM answer + judge)", qaTable(card.qa), "")
  lines.push(
    "Efficiency",
    `  context tokens/question   ${e.avgContextTokens.toFixed(0)}  (full history ${e.avgFullHistoryTokens.toFixed(0)} → ${e.tokenReductionX.toFixed(1)}× reduction)`,
    `  latency                   ingest ${e.avgIngestMs.toFixed(1)} ms/case · retrieval ${e.avgRetrievalMs.toFixed(1)} ms/question`,
  )
  return lines.join("\n")
}

/** Markdown scorecard (for pasting into a README / PR / report). */
export function scorecardMarkdown(card: Scorecard): string {
  const c = card.config
  const e = card.efficiency
  const md: string[] = [
    `## Chitta benchmark — \`${c.dataset}\``,
    "",
    `**Config:** tier=${c.tier}, k=${c.k}, embedder=${c.embedder}, rerank=${c.rerank ? "on" : "off"}${c.answerModel ? `, answer=${c.answerModel}` : ""}${c.judgeModel ? `, judge=${c.judgeModel}` : ""} · ${card.cases} case(s), ${card.questions} question(s)`,
    "",
  ]
  if (card.retrieval) {
    md.push("### Tier A — retrieval", "", "| category | n | recall | nDCG | MRR | P |", "|---|---|---|---|---|---|")
    for (const r of card.retrieval) md.push(`| ${r.category} | ${r.n} | ${f3(r.recall)} | ${f3(r.ndcg)} | ${f3(r.mrr)} | ${f3(r.precision)} |`)
    md.push("")
  }
  if (card.qa) {
    md.push("### Tier B — end-to-end QA", "", "| category | n | correct | accuracy |", "|---|---|---|---|")
    for (const r of card.qa) md.push(`| ${r.category} | ${r.n} | ${r.correct} | ${f3(r.accuracy)} |`)
    md.push("")
  }
  md.push(
    "### Efficiency",
    "",
    `- Context tokens/question: **${e.avgContextTokens.toFixed(0)}** vs ${e.avgFullHistoryTokens.toFixed(0)} full-history → **${e.tokenReductionX.toFixed(1)}× reduction**`,
    `- Latency: ${e.avgIngestMs.toFixed(1)} ms/case ingest · ${e.avgRetrievalMs.toFixed(1)} ms/question retrieval`,
  )
  return md.join("\n")
}

export function scorecardJson(card: Scorecard): string {
  return JSON.stringify(card, null, 2)
}
