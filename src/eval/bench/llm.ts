// Tier-B (end-to-end QA) LLM client. Talks to an OpenAI-compatible /chat/completions
// endpoint - point it at the SAME local/sovereign model Chitta's extractor uses
// (vLLM/SGLang/Ollama) so nothing leaves the building. HTTP + auth + env-var
// conventions are copied verbatim from src/embedded/extractors/llm.ts so a benchmark
// run and normal ingestion authenticate identically.
//
// Two roles, one client:
//  - answer(): the system-under-test answering a question FROM the retrieved context
//    ONLY, and abstaining ("I don't know") when the answer isn't there. That abstention
//    is what makes the `abstention` category measurable.
//  - judge(): LLM-as-judge grading a prediction against the gold answer SEMANTICALLY
//    (a paraphrase is correct), which string equality could never do.

import type { BenchLlm } from "./types"

export interface HttpBenchLlmConfig {
  /** OpenAI-compatible base, e.g. http://localhost:8000 (matches LlmExtractorConfig.endpoint). */
  endpoint: string
  /** Model that answers questions from context. Defaults to "default". */
  answerModel?: string
  /** Model that grades predictions vs gold. Defaults to "default". */
  judgeModel?: string
  apiKey?: string
  fetchImpl?: typeof fetch
}

// The answer model is confined to the supplied context and told to emit an EXACT
// sentinel when it can't answer - qa.ts detects that sentinel (and refusal paraphrases)
// to score abstention.
const ANSWER_SYSTEM = [
  "You answer the QUESTION using ONLY the information in the provided CONTEXT.",
  "Do NOT use any outside knowledge, and do NOT guess.",
  'If the CONTEXT does not contain the answer, reply with EXACTLY "I don\'t know" and nothing else.',
  "Otherwise answer as concisely as possible - just the fact asked for, no preamble or explanation.",
].join(" ")

// The judge grades meaning, not characters: a paraphrase, a superset, or a
// differently-worded but equivalent answer is CORRECT. Output is a single token so it
// parses unambiguously.
const JUDGE_SYSTEM = [
  "You are grading a PREDICTED answer against a GOLD answer for a QUESTION.",
  "Judge by MEANING, not wording: a paraphrase, a superset, or any semantically equivalent",
  "answer is correct even if the exact words differ.",
  "It is incorrect only if the prediction is factually wrong, contradicts the gold, or fails to answer.",
  'Reply with a SINGLE word: "CORRECT" or "INCORRECT". No punctuation, no explanation.',
].join(" ")

export class HttpBenchLlm implements BenchLlm {
  private readonly fetch: typeof fetch
  private readonly answerModel: string
  private readonly judgeModel: string

  constructor(private readonly cfg: HttpBenchLlmConfig) {
    this.fetch = cfg.fetchImpl ?? fetch
    this.answerModel = cfg.answerModel || "default"
    this.judgeModel = cfg.judgeModel || "default"
  }

  // Mirrors LlmExtractor.chat exactly: same path, headers, body shape, and lenient
  // response parse. temperature 0 keeps both answering and judging deterministic.
  private async chat(model: string, system: string, user: string): Promise<string> {
    const res = await this.fetch(`${this.cfg.endpoint.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    })
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    return body.choices?.[0]?.message?.content ?? ""
  }

  async answer(question: string, context: string): Promise<string> {
    const user = `CONTEXT:\n${context}\n\nQUESTION: ${question}`
    const out = await this.chat(this.answerModel, ANSWER_SYSTEM, user)
    return out.trim()
  }

  async judge(question: string, gold: string, predicted: string): Promise<boolean> {
    const user = `QUESTION: ${question}\nGOLD ANSWER: ${gold}\nPREDICTED ANSWER: ${predicted}`
    const out = await this.chat(this.judgeModel, JUDGE_SYSTEM, user)
    // "INCORRECT" contains "CORRECT", so check the negative first.
    const verdict = out.toUpperCase()
    if (verdict.includes("INCORRECT")) return false
    return verdict.includes("CORRECT")
  }
}

/** Build a Tier-B LLM from the same env Chitta's extractor reads. Returns null when
 *  CONTEXT_LLM_URL is unset so the runner can skip Tier B without a hard dependency on
 *  any model. Optional args override the model per role (answer vs judge). */
export function httpBenchLlmFromEnv(answerModel?: string, judgeModel?: string): HttpBenchLlm | null {
  const endpoint = process.env.CONTEXT_LLM_URL
  if (!endpoint) return null
  const base = process.env.CONTEXT_LLM_MODEL || "default"
  return new HttpBenchLlm({
    endpoint,
    answerModel: answerModel ?? base,
    judgeModel: judgeModel ?? base,
    apiKey: process.env.CONTEXT_LLM_KEY,
  })
}
