// TIME-AWARE re-rank. A question like "which book did I finish a week ago?" or "what did I buy
// last month?" names a time relative to WHEN it is asked; the memories that answer it are the ones
// whose content happened then. Deterministic English parsing of the common relative forms into a
// time window (or a "most recent" preference), then a boost for candidate records whose
// occurredAt (the caller-supplied content time; falls back to when the record was stored) fits.
// A boost, never a filter: a misparse can only reorder, not hide a record. CONTEXT_TIME=0 off.
import type { SqliteStore } from "../sqlite-store"
import type { FusedResult } from "./fuse"

const DAY = 86_400_000
const UNIT: Record<string, number> = { day: DAY, week: 7 * DAY, month: 30.44 * DAY, year: 365.25 * DAY }
const NUM: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, couple: 2, "a couple of": 2, few: 3, "a few": 3, several: 4,
}
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
const WEEKDAY = /\blast (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/

export interface TimeIntent {
  /** [from, to] in ms - content in this window is what the question asks about. */
  window?: [number, number]
  /** "most recently", "lately", "latest" - prefer the newest candidates. */
  recent?: boolean
}

/** Parse a stored date: ms, ISO, or forms like "2023/05/20 (Sat) 02:21". null if unparseable. */
export function parseDate(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v !== "string" || !v.trim()) return null
  const s = v.replace(/\((mon|tue|wed|thu|fri|sat|sun)[a-z]*\)/gi, " ").replace(/\s+/g, " ").trim()
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

function amount(word: string): number {
  return /^\d+$/.test(word) ? Number(word) : (NUM[word] ?? 1)
}

/** The time a question refers to, relative to `now`. null when it names none. */
export function parseTimeIntent(query: string, now: number): TimeIntent | null {
  const q = query.toLowerCase()
  const intent: TimeIntent = {}
  let m: RegExpExecArray | null
  const N = "(\\d+|a couple of|a few|couple|few|several|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)"
  if ((m = new RegExp(`\\b${N} (day|week|month|year)s? ago\\b`).exec(q))) {
    const span = amount(m[1]) * UNIT[m[2]]
    const tol = Math.max(2 * DAY, 0.35 * span)
    intent.window = [now - span - tol, now - span + tol]
  } else if ((m = new RegExp(`\\b(?:past|last|previous) ${N} (day|week|month|year)s?\\b`).exec(q))) {
    intent.window = [now - amount(m[1]) * UNIT[m[2]] * 1.2 - DAY, now + DAY]
  } else if ((m = /\b(?:past|last|previous) (day|week|month|year)\b/.exec(q))) {
    intent.window = [now - 2 * UNIT[m[1]], now + DAY]
  } else if (/\blast weekend\b/.test(q)) {
    intent.window = [now - 10 * DAY, now]
  } else if (/\byesterday\b/.test(q)) {
    intent.window = [now - 2 * DAY, now]
  } else if (WEEKDAY.test(q)) {
    intent.window = [now - 9 * DAY, now]
  } else if ((m = /\bthis (week|month|year)\b/.exec(q))) {
    intent.window = [now - UNIT[m[1]] - DAY, now + DAY]
  } else if ((m = new RegExp(`\\b(?:in|during|of) (${MONTHS.join("|")})(?: (\\d{4}))?\\b`).exec(q))) {
    const mi = MONTHS.indexOf(m[1])
    const ref = new Date(now)
    let y = m[2] ? Number(m[2]) : ref.getUTCFullYear()
    if (!m[2] && Date.UTC(y, mi, 1) > now) y-- // "in March" asked in January means last March
    intent.window = [Date.UTC(y, mi, 1) - 2 * DAY, Date.UTC(y, mi + 1, 1) + 2 * DAY]
  }
  if (/\b(most recent(ly)?|latest|lately|these days|nowadays|recently)\b/.test(q)) intent.recent = true
  return intent.window || intent.recent ? intent : null
}

/** Boost candidates by time fit. Mutates rrf in place and re-sorts; no-op without an intent. */
export function timeStage(store: SqliteStore, merged: FusedResult[], query: string, now: number): void {
  if (/^(0|false|off)$/i.test(process.env.CONTEXT_TIME ?? "1") || merged.length === 0) return
  const intent = parseTimeIntent(query, now)
  if (!intent) return
  const recIds = [...new Set(merged.map((r) => r.metadata.recordId).filter(Boolean) as string[])]
  if (!recIds.length) return
  const when = new Map<string, number>()
  for (const row of store.db
    .query(
      `SELECT id, COALESCE(json_extract(data,'$.occurredAt'), json_extract(data,'$.createdAt')) t
       FROM nodes WHERE coll = 'records' AND id IN (${recIds.map(() => "?").join(",")})`,
    )
    .all(...recIds) as Array<{ id: string; t: unknown }>) {
    const t = parseDate(row.t)
    if (t != null) when.set(row.id, t)
  }
  const boost = Number(process.env.CONTEXT_TIME_BOOST ?? 1.5)
  // "most recent": rank the dated candidates newest-first and lift the newest most (up to x1.3)
  const newest = intent.recent ? [...when.entries()].filter(([, t]) => t <= now + DAY).sort((a, b) => b[1] - a[1]).map(([id]) => id) : []
  for (const r of merged) {
    const t = when.get(r.metadata.recordId as string)
    if (t == null) continue
    if (intent.window && t >= intent.window[0] && t <= intent.window[1]) r.rrf *= boost
    if (newest.length) {
      const i = newest.indexOf(r.metadata.recordId as string)
      if (i >= 0) r.rrf *= 1 + 0.3 * (1 - i / newest.length)
    }
  }
  merged.sort((a, b) => b.rrf - a.rrf)
}
