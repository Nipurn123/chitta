// Passage-extraction helpers - shared across rerank, diversity and trace stages.
import { cleanLine, isBoilerplate } from "../extract"

export function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

// Query tokenizer for passage scoring - meaningful tokens only (acronyms/numbers kept).
export function queryTokens(query: string): string[] {
  return [...new Set((query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 3))]
}

// PASSAGE EXTRACTION - a retrieved chunk can be a coarse multi-fact digest (a whole
// scraped page), so returning the whole chunk buries the answer. We split it into
// sentences/lines, drop markdown + boilerplate, and return the line that best matches
// the query terms (term-length-weighted, so specific/rare terms dominate). This turns
// "matched the right digest" into "returned the exact fact" - at read time, no
// re-ingest, and it transparently skips any leftover cookie/nav line in a chunk.
export function bestPassage(content: string, terms: string[]): string {
  const lines = content
    .trim()
    .split(/\n|(?<=[.!?])\s+/)
    .map((l) => cleanLine(l))
    .filter((l) => l.length > 0 && !isBoilerplate(l))
  if (lines.length === 0) return "" // all boilerplate / no substance → caller drops it
  if (lines.length === 1) return lines[0]
  let best: { line: string; score: number } | null = null
  for (const line of lines) {
    const low = line.toLowerCase()
    let score = 0
    for (const t of terms) if (low.includes(t)) score += t.length // rarer/longer terms weigh more
    if (score > 0 && (!best || score > best.score)) best = { line, score }
  }
  return best ? best.line : lines[0]
}
