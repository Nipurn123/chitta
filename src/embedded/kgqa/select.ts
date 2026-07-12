// Relevance filtering + line gathering. Decides whether a query is BROAD (return
// everything about an entity) or SPECIFIC (semantically filter the candidate lines),
// and pulls exact lines from accessible chunks.

import { embedQueryWith, type EmbeddingProvider } from "../../provider"
import type { SqliteStore } from "../sqlite-store"
import { cleanLine, isBoilerplate } from "../extract"
import { cosine } from "./text"

// Generic question words to strip when deciding if a query is SPECIFIC (asks about
// a particular aspect) vs BROAD (just names the entity → return everything).
export const QUERY_STOP = new Set([
  "about", "info", "information", "news", "tell", "me", "what", "whats", "is", "are", "do", "does", "did",
  "the", "a", "an", "of", "on", "for", "and", "company", "companies", "details", "detail", "give", "show", "all", "any",
  "please", "know", "regarding", "related", "to", "with", "recent", "latest", "update", "updates", "who", "which",
  // generic RELATIONAL words - non-discriminating, so "X partnerships" returns ALL of X's
  // relationships (let the LLM deduce), rather than only lines that literally say "partnership".
  "partner", "partners", "partnered", "partnering", "partnership", "partnerships",
  "relationship", "relationships", "deal", "deals", "collaboration", "collaborations", "collaborate",
  "connection", "connections", "work", "works", "working", "involved", "between",
  // comparison / full-coverage signals - these mean "give me everything", not a filter.
  "compare", "comparison", "versus", "vs", "both", "each", "every", "everything", "anything", "list", "summary",
])

// Query words that signal the user wants COMPREHENSIVE coverage (union of all the
// named entities' facts), not the single connecting line.
export const WANTS_ALL = /\b(compare|comparison|versus|vs|both|each|every|everything|all|list|summary)\b/

// Narrow candidate lines to the query. First prefer lines that mention ALL named
// anchors ("SAP" + "Google" → only the SAP+Google line, not every Google line);
// then apply the broad/specific semantic filter on what remains.
export async function narrow(
  embeddings: EmbeddingProvider,
  question: string,
  anchors: string[],
  anchorSet: Set<string>,
  lines: string[],
): Promise<string[]> {
  if (lines.length <= 1) return lines
  let candidate = lines
  // Intersection narrows "SAP + Google" to their shared line - UNLESS the query is
  // a comparison/coverage request ("compare X and Y"), where we want all of both.
  if (anchors.length > 1 && !WANTS_ALL.test(question.toLowerCase())) {
    const inter = lines.filter((l) => {
      const ll = l.toLowerCase()
      return anchors.every((a) => ll.includes(a))
    })
    if (inter.length > 0) candidate = inter
  }
  return selectByQuery(embeddings, question, anchorSet, candidate)
}

// Broad query (only anchor terms) → return all; specific (extra content words) →
// embed the full query and keep only lines that semantically match it.
export async function selectByQuery(
  embeddings: EmbeddingProvider,
  question: string,
  anchorSet: Set<string>,
  lines: string[],
): Promise<string[]> {
  if (lines.length <= 1) return lines
  const residual = question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !QUERY_STOP.has(w) && !anchorSet.has(w))
  if (residual.length === 0) return lines // broad → everything

  const q = await embedQueryWith(embeddings, question)
  const scored: Array<{ line: string; s: number }> = []
  for (const line of lines) scored.push({ line, s: cosine(q, await embeddings.embedDense(line)) })
  scored.sort((a, b) => b.s - a.s)
  const top = scored[0].s
  const margin = Number(process.env.CONTEXT_LINE_MARGIN ?? 0.08)
  return scored.filter((x) => x.s >= top - margin).map((x) => x.line)
}

export function linesMentioningAny(store: SqliteStore, terms: string[], accessibleVids: string[]): string[] {
  const out = new Set<string>()
  for (const term of terms) for (const l of linesMentioning(store, term, accessibleVids)) out.add(l)
  return [...out]
}

// Exact lines/sentences from accessible chunks that mention the entity label.
export function linesMentioning(store: SqliteStore, label: string, accessibleVids: string[]): string[] {
  if (accessibleVids.length === 0) return []
  const vp = accessibleVids.map(() => "?").join(",")
  const rows = store.db
    .query(`SELECT content FROM chunks WHERE virtual_record_id IN (${vp}) AND content LIKE ?`)
    .all(...accessibleVids, `%${label}%`) as Array<{ content: string }>
  const want = label.toLowerCase()
  const out = new Set<string>()
  for (const r of rows) {
    for (const raw of r.content.split(/\n|(?<=[.!?])\s+/)) {
      const line = cleanLine(raw) // strip markdown ** / # / bullets
      if (line && !isBoilerplate(line) && line.toLowerCase().includes(want)) out.add(line)
    }
  }
  return [...out]
}
