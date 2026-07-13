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

/** One numbered note handed to the model - also returned to the caller as the citation list. */
export interface AskNote {
  n: number
  /** Where it came from: the typed graph's exact answer, a current atomic fact, or a search snippet. */
  kind: "graph" | "fact" | "snippet"
  text: string
  /** Human source label (record name / citation), when known. */
  name?: string
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
        label: `${path.basename(modelPath)} (in-process)`,
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

/** Gather the numbered evidence for a question - the SAME zero-token retrieval the rest of
 *  Chitta runs, flattened into notes: the typed graph's exact answer first (highest precision),
 *  then the current atomic facts (belief-revised - superseded truths are already gone), then
 *  hybrid search snippets. Deduped, capped, ACL-scoped like everything else. */
export async function gatherAskContext(
  ctx: EmbeddedContext,
  userId: string,
  orgId: string,
  question: string,
  limit = 8,
): Promise<AskNote[]> {
  const [exact, facts, search] = await Promise.all([
    ctx.ask(question, userId, orgId).catch(() => null),
    ctx.recallMemories(question, userId, orgId, 6).catch(() => []),
    ctx.searchWithGraph(question, userId, orgId, undefined, limit).catch(() => ({ searchResults: [] as Array<{ content: string; metadata: unknown }> })),
  ])

  const notes: AskNote[] = []
  const seen = new Set<string>()
  let budget = PROMPT_CHARS
  const push = (kind: AskNote["kind"], text: string, name?: string) => {
    const t = text.trim().slice(0, NOTE_CHARS)
    const key = norm(t)
    if (!t || seen.has(key) || budget - t.length < 0 || notes.length >= limit) return
    seen.add(key)
    budget -= t.length
    notes.push({ n: notes.length + 1, kind, text: t, name })
  }

  if (exact) for (const f of exact.facts.slice(0, 3)) push("graph", f, exact.citations.join(", ") || undefined)
  for (const f of facts) push("fact", f.memory)
  for (const r of search.searchResults) {
    const m = r.metadata as { recordName?: string }
    push("snippet", r.content, m?.recordName)
  }
  return notes
}

const SYSTEM_PROMPT = [
  "You answer questions from the user's saved memory.",
  "Use ONLY the numbered memory notes given to you - never outside knowledge.",
  "Cite the notes you used with their numbers in square brackets, like [1] or [2][3].",
  'If the notes do not contain the answer, reply exactly: "I don\'t have that in memory."',
  "Be direct. Answer in one to three short sentences.",
].join(" ")

export function buildAskPrompt(question: string, notes: AskNote[]): { system: string; user: string } {
  const lines = notes.map((s) => `[${s.n}]${s.name ? ` (${s.name})` : ""} ${s.text}`)
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
  const { system, user } = buildAskPrompt(question, notes)
  const answer = (await generate(system, user, opts.onToken)).trim()
  return { answer, sources: notes, synthesized: true, model: opts.model }
}
