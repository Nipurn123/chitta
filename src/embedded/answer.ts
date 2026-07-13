// `ask` - the optional ANSWER layer over the zero-token memory. Retrieval stays exactly
// what it is (graph + facts + hybrid search, no tokens, no model); this module only adds
// the last step: hand the retrieved notes to a SMALL local LLM and stream back one direct,
// cited answer instead of a list of snippets.
//
// Model resolution, in order:
//   1. CONTEXT_LLM_URL           - any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, cloud)
//   2. in-process node-llama-cpp - no server, no setup: a tiny GGUF (Qwen2.5-0.5B, ~0.4 GB)
//      auto-downloads ONCE to the app data dir, then answers in well under a second
// Everything degrades honestly: no notes -> "I don't have that in memory" without ever
// invoking a model; no model available -> the CLI falls back to showing the notes.

import path from "node:path"
import os from "node:os"
import fs from "node:fs"
import type { EmbeddedContext } from "./index"
import type { EmbeddingProvider } from "../provider"
import { cosine } from "./retrieval/passage"

/** One numbered note handed to the model - also returned to the caller as the citation list. */
export interface AskNote {
  n: number
  /** Where it came from: the typed graph's exact answer, a current atomic fact, or a search snippet. */
  kind: "graph" | "fact" | "snippet"
  text: string
  /** Human source label (record name / citation), when known. */
  name?: string
  /** Relevance of this note to the question (query-note cosine; 1 on the lexical embedder). Set by
   *  gatherAskContext, which ranks by it, and reused by the grounding gate. */
  score?: number
}

export interface AskResult {
  answer: string
  /** The notes the answer was grounded in ([n] citations point into this list). */
  sources: AskNote[]
  /** False when memory had nothing relevant - no model was invoked. */
  synthesized: boolean
  /** Which model produced the answer (label of the resolved generator). */
  model?: string
}

/** A pluggable text generator: system + user prompt in, final text out; streams via onToken. */
export type Generate = (system: string, user: string, onToken?: (t: string) => void) => Promise<string>

export interface Answerer {
  generate: Generate
  /** Human-readable model label, e.g. "Qwen2.5-0.5B-Instruct-Q4_K_M.gguf (in-process)". */
  label: string
  kind: "remote" | "local"
}

// ── model files ──

/** Default local model: Qwen2.5-0.5B instruct, Q4_K_M (~379 MB) - measured on this codebase:
 *  loads in ~1.2 s, answers grounded questions in 0.1-0.9 s on a laptop CPU. */
export const DEFAULT_ASK_MODEL_URL =
  "https://huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf"

/** Where downloaded GGUFs live - next to the personal store, so `rm -rf` of one dir removes all. */
export function askModelsDir(): string {
  return path.join(os.homedir(), ".local", "share", "100xprompt", "models")
}

/** The on-disk path a model spec resolves to WITHOUT downloading (for doctor/status). */
export function askModelPath(spec?: string): string {
  const s = spec ?? process.env.CONTEXT_ASK_MODEL
  if (s && !/^https?:/i.test(s)) return s // a local file path is used as-is
  const url = s && /^https?:/i.test(s) ? s : DEFAULT_ASK_MODEL_URL
  return path.join(askModelsDir(), decodeURIComponent(new URL(url).pathname.split("/").pop()!))
}

/** Ensure the ask model exists locally, downloading it once (atomic .part -> rename).
 *  `spec` may be a file path or an https URL; defaults to CONTEXT_ASK_MODEL, then Qwen 0.5B. */
export async function ensureAskModel(
  spec?: string,
  onProgress?: (gotBytes: number, totalBytes: number) => void,
): Promise<string> {
  const s = spec ?? process.env.CONTEXT_ASK_MODEL
  if (s && !/^https?:/i.test(s)) {
    if (!fs.existsSync(s)) throw new Error(`ask model not found: ${s} (CONTEXT_ASK_MODEL / --model must be a .gguf path or an https URL)`)
    return s
  }
  const url = s && /^https?:/i.test(s) ? s : DEFAULT_ASK_MODEL_URL
  const dest = askModelPath(s)
  if (fs.existsSync(dest)) return dest
  fs.mkdirSync(askModelsDir(), { recursive: true })
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`model download failed: HTTP ${res.status} for ${url}`)
  const total = Number(res.headers.get("content-length") ?? 0)
  const tmp = `${dest}.part`
  const fd = fs.openSync(tmp, "w")
  let got = 0
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      fs.writeSync(fd, value)
      got += value.byteLength
      onProgress?.(got, total)
    }
  } finally {
    fs.closeSync(fd)
  }
  if (total > 0 && got < total) {
    fs.rmSync(tmp, { force: true })
    throw new Error(`model download truncated (${got}/${total} bytes) - re-run to retry`)
  }
  fs.renameSync(tmp, dest)
  return dest
}

// ── generators ──

/** OpenAI-compatible endpoint generator (CONTEXT_LLM_URL). Same URL rule as the extractor:
 *  a base URL gets /v1/chat/completions appended; a full .../chat/completions is used verbatim. */
export function remoteAnswerer(endpoint: string, model?: string, apiKey?: string): Answerer {
  const base = endpoint.replace(/\/$/, "")
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/v1/chat/completions`
  const mdl = model ?? process.env.CONTEXT_LLM_MODEL ?? "default"
  const key = apiKey ?? process.env.CONTEXT_LLM_KEY
  return {
    kind: "remote",
    label: `${mdl} @ ${endpoint}`,
    generate: async (system, user, onToken) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({
          model: mdl,
          temperature: 0.2,
          max_tokens: Number(process.env.CONTEXT_LLM_MAX_TOKENS ?? 512),
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      })
      if (!res.ok) throw new Error(`LLM endpoint returned HTTP ${res.status} (${endpoint})`)
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const text = body.choices?.[0]?.message?.content ?? ""
      if (text && onToken) onToken(text) // remote path emits in one piece
      return text
    },
  }
}

// In-process llama.cpp generator. The import uses a VARIABLE specifier so typecheck and
// bundling never depend on the native package's type graph - it resolves at runtime from
// the real dependency. Memoized per model path: the first ask pays the ~1 s model load,
// every later ask in the same process reuses the loaded weights.
const localMemo = new Map<string, Promise<Answerer>>()

export function localAnswerer(modelPath: string): Promise<Answerer> {
  let memo = localMemo.get(modelPath)
  if (!memo) {
    memo = (async (): Promise<Answerer> => {
      const spec = "node-llama-cpp"
      const nlc = (await import(spec)) as {
        getLlama: (o?: Record<string, unknown>) => Promise<{ loadModel: (o: { modelPath: string }) => Promise<LlamaModel> }>
        LlamaChatSession: new (o: { contextSequence: unknown; systemPrompt?: string }) => LlamaSession
        LlamaLogLevel?: Record<string, unknown>
      }
      const llama = await nlc.getLlama({ logLevel: nlc.LlamaLogLevel?.error ?? "error" })
      const model = await llama.loadModel({ modelPath })
      return {
        kind: "local",
        label: `${path.basename(modelPath).replace(/\.gguf$/i, "")} (in-process)`,
        generate: async (system, user, onToken) => {
          // Fresh context per question: creation is milliseconds (the load above is the
          // expensive part) and it guarantees no state bleeds between questions.
          const context = await model.createContext({ contextSize: 4096 })
          try {
            const session = new nlc.LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt: system })
            return await session.prompt(user, {
              maxTokens: Number(process.env.CONTEXT_LLM_MAX_TOKENS ?? 512),
              temperature: 0.1,
              onTextChunk: onToken,
            })
          } finally {
            await context.dispose?.()
          }
        },
      }
    })()
    memo.catch(() => localMemo.delete(modelPath)) // a failed load must not poison future tries
    localMemo.set(modelPath, memo)
  }
  return memo
}

interface LlamaModel {
  createContext: (o: { contextSize?: number }) => Promise<LlamaContext>
}
interface LlamaContext {
  getSequence: () => unknown
  dispose?: () => Promise<void> | void
}
interface LlamaSession {
  prompt: (text: string, o?: { maxTokens?: number; temperature?: number; onTextChunk?: (t: string) => void }) => Promise<string>
}

export interface ResolveAnswererOptions {
  /** Explicit model: a .gguf path or an https URL. Forces the in-process path. */
  model?: string
  /** Download progress for the one-time model fetch. */
  onProgress?: (gotBytes: number, totalBytes: number) => void
}

/** Pick the generator: an explicit --model forces in-process; else CONTEXT_LLM_URL wins;
 *  else the in-process default model (downloaded once). */
export async function resolveAnswerer(opts: ResolveAnswererOptions = {}): Promise<Answerer> {
  const url = process.env.CONTEXT_LLM_URL
  if (url && !opts.model) return remoteAnswerer(url)
  const modelPath = await ensureAskModel(opts.model, opts.onProgress)
  return localAnswerer(modelPath)
}

/** Ask-layer status for doctor/warm - never downloads or loads anything. */
export function askStatus(): { ready: boolean; detail: string } {
  const url = process.env.CONTEXT_LLM_URL
  if (url) return { ready: true, detail: `remote - ${process.env.CONTEXT_LLM_MODEL || "default"} @ ${url}` }
  const p = askModelPath()
  if (fs.existsSync(p)) return { ready: true, detail: `local - ${path.basename(p)} (in-process, ready)` }
  return { ready: false, detail: `local - downloads ${path.basename(p)} (~0.4 GB, once) on first \`chitta ask\`` }
}

// ── retrieval -> notes -> answer ──

const NOTE_CHARS = 400 // per-note cap - keeps the whole prompt inside a tiny model's context
const PROMPT_CHARS = 4000 // total notes budget

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim()

// Internal record/entity ids (mem-…, rec-…, file:…, chunk#n, raw hashes) are meaningless to a
// human AND, worse, when fed into the prompt a small model echoes them into its answer
// ("[1] (mem-abc…) Elon Musk lives in Texas"). A note's source label is only worth showing when
// it is a real human name (a filename, a titled record); otherwise drop it. Applied at the
// source so both the model prompt and the CLI citation footer stay clean.
const idLike = (p: string): boolean =>
  /^(mem|rec)-[a-z0-9-]+$/i.test(p) || /^file:/i.test(p) || /#\d+$/.test(p) || /^[0-9a-f]{8,}(-[0-9a-f]+)*$/i.test(p)
function cleanSourceName(name?: string): string | undefined {
  if (!name) return undefined
  const human = name.split(",").map((p) => p.trim()).filter((p) => p && !idLike(p))
  return human.length ? human.join(", ") : undefined
}

/** Gather the numbered evidence for a question - the SAME zero-token retrieval the rest of Chitta
 *  runs (the typed graph's exact answer, the current belief-revised atomic facts, and hybrid
 *  search passages), pooled and then RANKED BY RELEVANCE to the question, best first.
 *
 *  Ranking (not source order) is the point: filling the note budget graph-first then facts-first
 *  let a noisy / code-heavy store pack every slot with loosely-matched typed triples ("Talk likes
 *  pirate") before the hybrid-search passage that actually answers ("User loves coding") ever got
 *  one. Scoring every candidate by query cosine surfaces the relevant note whatever source it came
 *  from - a precise KGQA answer still ranks at the top, a loose one is demoted out. Deduped,
 *  budget-capped, ACL-scoped like everything else. On the lexical (hash) embedder, where an
 *  absolute cosine isn't meaningful, we keep the original source order (graph > facts > snippets). */
export async function gatherAskContext(
  ctx: EmbeddedContext,
  userId: string,
  orgId: string,
  question: string,
  limit = 8,
): Promise<AskNote[]> {
  // Pull a WIDER candidate pool than the final note count: on a large store the note that answers
  // may not be in the top few by any single signal, so we over-fetch and let cosine ranking pick.
  const pool = Math.max(20, limit * 2)
  const [exact, facts, search] = await Promise.all([
    ctx.ask(question, userId, orgId).catch(() => null),
    ctx.recallMemories(question, userId, orgId, pool).catch(() => []),
    ctx.searchWithGraph(question, userId, orgId, undefined, pool).catch(() => ({ searchResults: [] as Array<{ content: string; metadata: unknown }> })),
  ])

  type Cand = { kind: AskNote["kind"]; text: string; name?: string }
  const cands: Cand[] = []
  if (exact) for (const f of exact.facts) cands.push({ kind: "graph", text: f, name: cleanSourceName(exact.citations.join(", ")) })
  for (const f of facts) cands.push({ kind: "fact", text: f.memory })
  for (const r of search.searchResults) cands.push({ kind: "snippet", text: r.content, name: cleanSourceName((r.metadata as { recordName?: string })?.recordName) })

  const lexical = (await ctx.embeddings.isLexical?.()) ?? false
  const qv = lexical ? null : await (ctx.embeddings.embedQuery ? ctx.embeddings.embedQuery(question) : ctx.embeddings.embedDense(question))

  const seen = new Set<string>()
  const scored: Array<Cand & { score: number }> = []
  let order = 0
  for (const c of cands) {
    const text = c.text.trim().slice(0, NOTE_CHARS)
    const key = norm(text)
    if (!text || seen.has(key)) continue
    seen.add(key)
    // semantic: rank by query cosine; lexical: no calibrated cosine, so preserve source order.
    const score = qv ? cosine(qv, await ctx.embeddings.embedDense(text)) : 1 - order++ * 1e-6
    scored.push({ ...c, text, score })
  }
  scored.sort((a, b) => b.score - a.score)

  const notes: AskNote[] = []
  let budget = PROMPT_CHARS
  for (const c of scored) {
    if (notes.length >= limit || budget - c.text.length < 0) break
    budget -= c.text.length
    notes.push({ n: notes.length + 1, kind: c.kind, text: c.text, name: c.name, score: c.score })
  }
  return notes
}

// Grounded-answer instructions. The relevance GATE (below) is what deterministically refuses
// out-of-scope questions - so by the time the model runs, the notes are already relevant. Its
// job here is narrower: state ONLY what a note actually says, cite it, and still refuse if the
// notes are about the right subject but don't contain the specific asked-for fact (e.g. notes
// about a person that don't state their net worth). The refusal line is a backstop, phrased so
// it doesn't make a small model drop answers that ARE present.
const SYSTEM_PROMPT = [
  "You answer the user's question using ONLY the numbered memory notes provided.",
  "Every claim you make must be stated in a note; never add outside knowledge, even if you are sure.",
  "Cite each note you use by its number in brackets, like [1] or [2][3].",
  "If the notes are about the subject but do not state the specific fact asked for, say what you DO know from them and that you don't have the rest.",
  'If no note is relevant at all, reply exactly: "I don\'t have that in memory."',
  "Be direct: one to three short sentences.",
].join("\n")

// Refuse below this query-vs-note cosine (semantic embedders only). Calibrated on bge-small over
// real queries: in-store answers cluster ~0.66-0.80 (even when the stored fact is phrased
// differently from the question, e.g. "User loves coding" for "my coding preferences" ≈ 0.72),
// while out-of-scope questions sit ~0.31-0.51. 0.55 splits them - low enough not to falsely refuse
// a real answer worded unlike the question, high enough to still refuse off-topic. CONTEXT_ASK_FLOOR overrides.
const RELEVANCE_FLOOR = 0.55

/** The deterministic honesty gate: is the BEST gathered note actually relevant to the question?
 *  This is what stops a small model answering an out-of-scope question from its own pretraining -
 *  we decide relevance from retrieval, not from the model. Every note (including a KGQA graph
 *  answer) is held to the cosine floor: a precise typed answer scores high and passes, a loose one
 *  ("Talk likes pirate" for "coding preferences") is correctly refused. Skipped on the lexical
 *  (hash) embedder, whose cosine scale this floor is not calibrated for (the prompt is the only
 *  backstop there). Reuses gatherAskContext's precomputed note scores when present. */
export async function notesAreGrounded(
  embeddings: EmbeddingProvider,
  question: string,
  notes: AskNote[],
): Promise<{ grounded: boolean; best: number }> {
  if (notes.length === 0) return { grounded: false, best: 0 }
  if (await embeddings.isLexical?.()) return { grounded: true, best: 1 } // floor uncalibrated for hash
  const floor = Number(process.env.CONTEXT_ASK_FLOOR ?? RELEVANCE_FLOOR)
  // Notes carry a precomputed relevance score from gatherAskContext; fall back to embedding for
  // hand-built notes (tests / direct callers) that don't.
  const needEmbed = notes.some((n) => n.score === undefined)
  const qv = needEmbed ? await (embeddings.embedQuery ? embeddings.embedQuery(question) : embeddings.embedDense(question)) : null
  let best = 0
  for (const n of notes) {
    const s = n.score ?? cosine(qv!, await embeddings.embedDense(n.text))
    if (s > best) best = s
  }
  return { grounded: best >= floor, best }
}

export function buildAskPrompt(question: string, notes: AskNote[]): { system: string; user: string } {
  // Feed the model only the note NUMBER + text - not the source label. The label (a filename /
  // record name) is for the human's citation footer; putting it in the prompt just tempts a small
  // model to echo "(packages/…/foo.ts)" into its answer. It cites by number; we show the source.
  const lines = notes.map((s) => `[${s.n}] ${s.text}`)
  return { system: SYSTEM_PROMPT, user: `Memory notes:\n${lines.join("\n")}\n\nQuestion: ${question}` }
}

export interface AnswerOptions {
  onToken?: (t: string) => void
  /** Model label carried into the result (from the resolved Answerer). */
  model?: string
  /** Max notes to ground on (default 8). */
  limit?: number
}

/** Answer a question FROM MEMORY: zero-token retrieval gathers the notes, the local model
 *  only phrases them. When memory has nothing, it says so - without invoking any model. */
export async function answerFromMemory(
  ctx: EmbeddedContext,
  userId: string,
  orgId: string,
  question: string,
  generate: Generate,
  opts: AnswerOptions = {},
): Promise<AskResult> {
  const notes = await gatherAskContext(ctx, userId, orgId, question, opts.limit)
  if (notes.length === 0) {
    return {
      answer: "I don't have anything in memory about that yet. Store something (remember / chitta learn), then ask again.",
      sources: [],
      synthesized: false,
      model: opts.model,
    }
  }
  // Honesty gate: if nothing retrieved is actually relevant, refuse deterministically WITHOUT
  // invoking the model - a small model, handed only off-topic notes, would otherwise answer the
  // question from its own pretraining and fabricate a citation. Decide from retrieval, not the model.
  const { grounded } = await notesAreGrounded(ctx.embeddings, question, notes)
  if (!grounded) {
    return { answer: "I don't have that in memory.", sources: [], synthesized: false, model: opts.model }
  }
  const { system, user } = buildAskPrompt(question, notes)
  const answer = (await generate(system, user, opts.onToken)).trim()
  return { answer, sources: notes, synthesized: true, model: opts.model }
}
