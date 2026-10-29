// Probe the LLM fact-key extraction on a few real sessions: latency, count, and what comes back.
// usage: CONTEXT_LLM_URL=... CONTEXT_LLM_MODEL=... bun run facts-probe.ts <longmemeval.json> [n]
import { LlmExtractor } from "../../src/embedded/llm-extractor"
const data = (await Bun.file(process.argv[2]).json()) as any[]
const n = Number(process.argv[3] ?? 2)
const llm = new LlmExtractor({ endpoint: process.env.CONTEXT_LLM_URL!, model: process.env.CONTEXT_LLM_MODEL ?? "default" })
for (const q of data.slice(0, n)) {
  const i = q.haystack_session_ids.indexOf(q.answer_session_ids[0])
  const text = q.haystack_sessions[i].map((t: any) => `${t.role}: ${t.content}`).join("\n")
  const t0 = performance.now()
  const facts = await llm.extractFacts(text, q.haystack_dates[i])
  console.log(`\n== ${q.question}  (gold answer: ${q.answer})\n   ${text.length} chars -> ${facts.length} facts in ${((performance.now() - t0) / 1000).toFixed(1)}s`)
  for (const f of facts.slice(0, 12)) console.log(`   - ${f}`)
}
