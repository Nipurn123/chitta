// MEMORY READER (LLM mode): answer a question from memory, end to end. Retrieval finds the right
// sessions most of the time; what turns that into a correct answer is HOW they're read:
//   1. route  - one model call: what kind of answer is needed + search rewrites (the same call
//               that rewrites the query; no extra round trip)
//   2. search - wider for questions that gather many memories (counts, totals, timelines)
//   3. gather - per session: its best-matching rounds IN FULL plus its fact keys, dated, sessions in
//               date order, under a size budget (a single best line per session - what get_context
//               returns - drops the detail, the date, or the second instance a count needs)
//   4. read   - Chain-of-Note: dated notes per session first, then the answer, with rules for
//               counting, dates, changed facts, recommendations and "not in memory".
// Nothing here reads benchmark labels: the question's kind comes from the model, never a dataset.

import type { SqliteStore } from "./sqlite-store"
import type { EmbeddingProvider } from "../provider"
import type { RetrievalResponse } from "../types"
import type { QuestionKind } from "./extractors/llm"
import { decodeF32 } from "./store/vector-blob"
import { STOPWORDS } from "./store/fts"
import { parseDate } from "./retrieval/time-stage"

export interface ReaderDeps {
  store: SqliteStore
  embeddings: EmbeddingProvider
  search: (query: string, userId: string, orgId: string, trace: undefined, limit: number, opts: { now?: number; expansions?: string[] }) => Promise<RetrievalResponse>
}

export interface ReaderModel {
  complete(system: string, user: string): Promise<string>
  routeQuestion?(question: string): Promise<{ kind: QuestionKind; queries: string[] }>
}

export interface ReadOptions {
  model: ReaderModel
  /** "Now" for the question: ms, or a date string shown to the reader as today's date. */
  now?: number | string
  /** Sessions read for single-fact questions / for questions that gather many memories. */
  k?: number
  kWide?: number
}

export interface ReadResult {
  answer: string
  notes: string
  kind: QuestionKind
  recordIds: string[]
  contextChars: number
}

const WIDE_KINDS: QuestionKind[] = ["aggregate", "temporal"]

const READER_SYSTEM = [
  "You answer the user's QUESTION from their MEMORY: excerpts and facts from past conversations",
  "with the user, grouped by session, each session dated. Use only the memory - never outside",
  "knowledge about the user. TODAY is given; relative times in the question are relative to it.",
  "First write NOTES: for every session that bears on the question, the relevant facts with that",
  "session's date. Then write the final line as 'ANSWER: <answer>'. Rules:",
  "(1) Counting, totals, lists: list every distinct item with its session date, drop duplicates of",
  "the same item, then count or add - check the list before answering.",
  "(2) Time: state the date of each event involved, then compute explicitly (days between,",
  "which came first, how long ago from TODAY).",
  "(3) If statements conflict, the most recent dated one is the current truth; mention the change.",
  "(4) Requests for advice or recommendations: answer as a personalised recommendation that uses",
  "what the user said about their own tastes, gear, plans and situation.",
  "(5) Facts are often mentioned in passing inside a message about something else ('by the way,",
  "...'): read every excerpt to the end before deciding something is missing. If the memory really",
  "does not contain what is needed, say so plainly and what is missing - do not guess.",
  "(6) Keep the ANSWER short and direct; the reasoning belongs in NOTES.",
].join(" ")

/** Strip a chunk's own "[date] " header - the session header already carries the date. */
const bare = (c: string) => c.replace(/^\[[^\]\n]{4,40}\]\s/, "")

// Light stemmer for in-session word matching ("changed" ~ "change", "trips" ~ "trip").
const stem = (w: string) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w)
const words = (s: string) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1 && !STOPWORDS.has(w)).map(stem)

/** Rank a session's rounds for a question: meaning (dense cosine) PLUS the question's own words,
 *  rarer-in-this-session words counting more. Facts are often a passing remark inside a message
 *  about something else ("by the way, my old name was Johnson" in a turn about health insurance):
 *  that round's vector is about insurance, but it holds the question's words. Measured on such a
 *  miss: dense alone ranked the answer 9th of 18 rounds, outside the excerpts read. */
export function rankRounds(question: string, qv: number[], rounds: Array<{ c: string; v: Float32Array | null }>): number[] {
  const qt = [...new Set(words(question))]
  const sets = rounds.map((r) => new Set(words(r.c)))
  const w = qt.map((t) => Math.log(1 + rounds.length / Math.max(1, sets.filter((s) => s.has(t)).length)))
  const wSum = w.reduce((a, b) => a + b, 0) || 1
  const lexW = Number(process.env.CONTEXT_READER_LEX_W ?? 0.25)
  const score = rounds.map((r, i) => {
    let d = 0
    if (r.v) for (let j = 0; j < r.v.length && j < qv.length; j++) d += r.v[j] * qv[j]
    const lex = qt.reduce((a, t, k) => a + (sets[i].has(t) ? w[k] : 0), 0) / wSum
    return d + lexW * lex
  })
  return rounds.map((_, i) => i).sort((a, b) => score[b] - score[a])
}

/** The evidence for a set of sessions, as the reader sees it: per session its best excerpts in
 *  full (the chunks the search itself returned, then the best-ranked rounds - more for the top
 *  sessions) plus its fact keys, sessions in date order, added in rank order until `budget`. */
export async function gatherMemory(
  deps: Pick<ReaderDeps, "store" | "embeddings">,
  question: string,
  recordIds: string[],
  opts: { rounds?: number; facts?: number; budget?: number; full?: number; hits?: Map<string, Set<string>> } = {},
): Promise<{ text: string; included: string[] }> {
  const rounds = opts.rounds ?? Number(process.env.CONTEXT_READER_ROUNDS ?? 3)
  const maxFacts = opts.facts ?? 20
  const budget = opts.budget ?? Number(process.env.CONTEXT_READER_CHARS ?? 64_000)
  // Tiered: the first `full` sessions get facts + excerpts; the rest facts only (compact), so a
  // question that gathers many memories can see every instance without the excerpts of all of them.
  const full = opts.full ?? recordIds.length
  const emb = deps.embeddings
  const qv = await (emb.embedQuery ? emb.embedQuery(question) : emb.embedDense(question))
  const chunkQ = deps.store.db.query("SELECT point_id p, content c, embedding e FROM chunks WHERE point_id LIKE ? ORDER BY rowid")
  const nodeQ = deps.store.db.query("SELECT json_extract(data,'$.occurredAt') o, json_extract(data,'$.createdAt') c FROM nodes WHERE id = ?")
  const sections: Array<{ id: string; t: number; text: string }> = []
  let used = 0
  for (const [rank, id] of recordIds.entries()) {
    const rows = chunkQ.all(`${id}#%`) as Array<{ p: string; c: string; e: Uint8Array | ArrayBuffer | string | null }>
    if (!rows.length) continue
    const facts = rows.filter((r) => /#f\d+$/.test(r.p)).slice(0, maxFacts).map((r) => `- ${bare(r.c)}`)
    // past the full tier: facts only - or, for a session without fact keys, its single best excerpt;
    // the top 3 sessions read 2 more rounds than the rest
    const take = rank < full ? rounds + (rank < 3 ? 2 : 0) : facts.length ? 0 : 1
    const body = rows.filter((r) => !/#f\d+$/.test(r.p))
    const order = rankRounds(question, qv, body.map((r) => ({ c: r.c, v: r.e ? decodeF32(r.e) : null })))
    const hit = opts.hits?.get(id)
    const picked = new Set<number>(take > 0 && hit ? body.flatMap((r, i) => (hit.has(r.p) ? [i] : [])) : []) // the search's own hits first
    for (const i of order) {
      if (picked.size >= take) break
      picked.add(i)
    }
    const scored = [...picked].sort((a, b) => a - b).map((i) => ({ i, c: bare(body[i].c) })) // the session's own order
    const node = nodeQ.get(id) as { o: unknown; c: unknown } | null
    const when = node?.o ?? node?.c
    const label = typeof when === "string" ? when : typeof when === "number" ? new Date(when).toISOString().slice(0, 10) : "unknown date"
    const text = [`### Session ${label}`, facts.length ? `Facts:\n${facts.join("\n")}` : "", scored.length ? `Excerpts:\n${scored.map((x) => x.c).join("\n...\n")}` : ""]
      .filter(Boolean)
      .join("\n")
    if (used + text.length > budget && sections.length) break
    used += text.length
    sections.push({ id, t: parseDate(when) ?? Number.MAX_SAFE_INTEGER, text })
  }
  sections.sort((a, b) => a.t - b.t)
  return { text: sections.map((s) => s.text).join("\n\n"), included: sections.map((s) => s.id) }
}

/** Ask the reader model over gathered memory; returns its answer line and its notes. */
export async function readMemory(model: ReaderModel, question: string, memory: string, today: string, kind: QuestionKind): Promise<{ answer: string; notes: string }> {
  const hint = kind === "single" ? "" : `\nThis question is about: ${kind}.`
  const out = (await model.complete(READER_SYSTEM, `TODAY: ${today}${hint}\n\nMEMORY:\n${memory || "(nothing relevant found)"}\n\nQUESTION: ${question}`)).trim()
  const i = out.search(/ANSWER:/i)
  if (i >= 0) return { answer: out.slice(i).replace(/^ANSWER:\s*/i, "").trim(), notes: out.slice(0, i).trim() }
  // The model wrote notes but no ANSWER line: one short follow-up turns the notes into the answer.
  if (!out) return { answer: "", notes: "" }
  const final = (await model.complete(FINAL_SYSTEM, `QUESTION: ${question}\n\nNOTES:\n${out}`).catch(() => "")).replace(/^ANSWER:\s*/i, "").trim()
  return { answer: final || out, notes: out }
}

const FINAL_SYSTEM = "Given a QUESTION and NOTES worked out from the user's memory, reply with only the final answer to the question, in one or two short sentences."

const todayOf = (now?: number | string) => (typeof now === "string" && now.trim() ? now.trim() : new Date(typeof now === "number" ? now : Date.now()).toISOString().slice(0, 10))

/** Route, search, gather, read - Chitta's end-to-end answer from memory. */
export async function answerQuestion(deps: ReaderDeps, question: string, userId: string, orgId: string, opts: ReadOptions): Promise<ReadResult> {
  const route = (await opts.model.routeQuestion?.(question).catch(() => null)) ?? { kind: "single" as QuestionKind, queries: [] }
  const k = breadth(route.kind, opts)
  const now = typeof opts.now === "string" ? (parseDate(opts.now) ?? undefined) : opts.now
  const res = await deps.search(question, userId, orgId, undefined, k, { now, expansions: route.queries })
  const { ids, hits } = searchHits(res)
  const mem = await gatherMemory(deps, question, ids, { full: fullTier(route.kind), hits })
  const { answer, notes } = await readMemory(opts.model, question, mem.text, todayOf(opts.now), route.kind)
  return { answer, notes, kind: route.kind, recordIds: mem.included, contextChars: mem.text.length }
}

/** A search response as the reader uses it: records in rank order, and per record the chunks the
 *  search itself returned (so the excerpts include what the hybrid search + reranker found). */
export function searchHits(res: RetrievalResponse): { ids: string[]; hits: Map<string, Set<string>> } {
  const ids: string[] = []
  const hits = new Map<string, Set<string>>()
  for (const r of res.searchResults) {
    const m = r.metadata as { recordId?: string; point_id?: string }
    if (!m.recordId) continue
    if (!ids.includes(m.recordId)) ids.push(m.recordId)
    if (m.point_id) (hits.get(m.recordId) ?? hits.set(m.recordId, new Set()).get(m.recordId)!).add(m.point_id)
  }
  return { ids, hits }
}

/** How many sessions a kind of question reads: 30 for questions that gather many memories (the
 *  first 10 in full, the rest as facts), 10 otherwise. */
export function breadth(kind: QuestionKind, opts: { k?: number; kWide?: number } = {}): number {
  return WIDE_KINDS.includes(kind) ? (opts.kWide ?? Number(process.env.CONTEXT_READER_K_WIDE ?? 30)) : (opts.k ?? Number(process.env.CONTEXT_READER_K ?? 10))
}
export function fullTier(kind: QuestionKind): number | undefined {
  return WIDE_KINDS.includes(kind) ? Number(process.env.CONTEXT_READER_FULL ?? 10) : undefined
}

/** The same gather + read over a GIVEN set of sessions (e.g. another retriever's) - so two
 *  retrievers can be compared under the identical reader. */
export async function answerFromRecords(
  deps: Pick<ReaderDeps, "store" | "embeddings">,
  question: string,
  recordIds: string[],
  opts: ReadOptions & { kind?: QuestionKind; hits?: Map<string, Set<string>> },
): Promise<ReadResult> {
  const kind = opts.kind ?? "single"
  const mem = await gatherMemory(deps, question, recordIds, { full: fullTier(kind), hits: opts.hits })
  const { answer, notes } = await readMemory(opts.model, question, mem.text, todayOf(opts.now), kind)
  return { answer, notes, kind, recordIds: mem.included, contextChars: mem.text.length }
}
