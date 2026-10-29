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

import type { AnswerOptions, BenchLlm, JudgeOptions } from "./types"

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

// Time questions ("how many days ago", "last month") are relative to when they're asked.
const ANSWER_TIME_NOTE =
  " The CURRENT DATE is given; for questions about time (how long ago, which came first, last month) reason from it and the dates in the CONTEXT."

// LongMemEval's grading rule per question type - the same rules its official
// src/evaluation/evaluate_qa.py applies (worded here, not copied). Used only when the dataset
// supplies its question type. For a publishable number, write the answers with --hyps and score
// them with that official script and GPT-4o.
const LME_STRICT =
  "The prediction is CORRECT if it contains the gold answer, is equivalent to it, or contains all the intermediate steps that lead to it. It is INCORRECT if it gives only part of the information the gold answer requires."
function lmeRule(o: JudgeOptions): string {
  if (o.abstention)
    return "The question is UNANSWERABLE from the user's history and GOLD explains why. The prediction is CORRECT only if it identifies the question as unanswerable (the information is missing or incomplete, or only other information is available)."
  switch (o.questionType) {
    case "single-session-preference":
      return "GOLD is a RUBRIC describing a good personalized response, not an exact answer. The prediction is CORRECT if it recalls and uses the user's personal information correctly; it need not cover every rubric point."
    case "temporal-reasoning":
      return `${LME_STRICT} Do not penalize off-by-one errors in counts of days, weeks or months (19 days when the answer is 18 is CORRECT).`
    case "knowledge-update":
      return `${LME_STRICT} If the prediction gives earlier information together with the updated answer, it is CORRECT as long as the updated answer is the required one.`
    default:
      return LME_STRICT
  }
}
function judgeSystem(o?: JudgeOptions): string {
  if (!o?.questionType && !o?.abstention) return JUDGE_SYSTEM
  return `You are grading a PREDICTED answer against a GOLD answer for a QUESTION. ${lmeRule(o)} Reply with a SINGLE word: "CORRECT" or "INCORRECT". No punctuation, no explanation.`
}

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
    // Accept either an OpenAI-style BASE url (append /v1/chat/completions) or a FULL
    // endpoint url that already ends in /chat/completions (e.g. Vertex AI's OpenAI-compatible
    // path .../endpoints/openapi/chat/completions). max_tokens must be generous: a "thinking"
    // model (Gemini 2.5, o-series) spends tokens on reasoning first, so a small cap returns
    // an EMPTY answer. Configurable via CONTEXT_LLM_MAX_TOKENS.
    const ep = this.cfg.endpoint.replace(/\/$/, "")
    const url = /\/chat\/completions$/.test(ep) ? ep : `${ep}/v1/chat/completions`
    const res = await this.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: Number(process.env.CONTEXT_LLM_MAX_TOKENS ?? 1024),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    })
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    return body.choices?.[0]?.message?.content ?? ""
  }

  async answer(question: string, context: string, opts?: AnswerOptions): Promise<string> {
    const date = opts?.questionDate
    const user = `${date ? `CURRENT DATE: ${date}\n\n` : ""}CONTEXT:\n${context}\n\nQUESTION: ${question}`
    const out = await this.chat(this.answerModel, date ? ANSWER_SYSTEM + ANSWER_TIME_NOTE : ANSWER_SYSTEM, user)
    return out.trim()
  }

  async judge(question: string, gold: string, predicted: string, opts?: JudgeOptions): Promise<boolean> {
    const user = `QUESTION: ${question}\nGOLD ANSWER: ${gold}\nPREDICTED ANSWER: ${predicted}`
    const out = await this.chat(this.judgeModel, judgeSystem(opts), user)
    // "INCORRECT" contains "CORRECT", so check the negative first.
    const verdict = out.toUpperCase()
    if (verdict.includes("INCORRECT")) return false
    if (verdict.includes("CORRECT")) return true
    // No verdict at all (a failed or empty call) is not a grade - throw, so a failed judge call
    // can't silently mark a right answer wrong. Callers that want "wrong" catch it.
    throw new Error("judge returned no verdict")
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
