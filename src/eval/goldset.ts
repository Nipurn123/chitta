// Gold-set generation - build a Q→relevant-record eval set from your OWN stored data,
// so retrieval quality can be measured without hand-labeling. Two paths:
//   • generateGoldSet (here): DETERMINISTIC - for each record, form a query from its
//     chunk's salient terms; the source record is the gold label. Zero LLM, great for
//     regression detection (does a query built from a record's own content retrieve it?).
//   • LLM path (the frontier model): generate natural / multi-hop questions whose source
//     chunk(s) are the gold labels - richer, but needs the calling model. (Doc only.)

import type { SqliteStore } from "../embedded/sqlite-store"
import type { GoldItem } from "./harness"

const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "for", "with", "from", "into", "of", "on", "in", "at", "to", "by", "as",
  "is", "are", "was", "were", "be", "this", "that", "these", "those", "it", "its", "will", "has", "have", "had",
  "more", "after", "over", "across", "than", "their", "they", "you", "your", "our", "we",
])

/** One query per record (default), built from the most salient terms of its first chunk. */
export function generateGoldSet(store: SqliteStore, opts: { terms?: number; perRecord?: number } = {}): GoldItem[] {
  const nTerms = opts.terms ?? 6
  const rows = store.db
    .query(
      `SELECT c.virtual_record_id v, c.content content
       FROM chunks c
       GROUP BY c.virtual_record_id`,
    )
    .all() as Array<{ v: string; content: string }>
  const gold: GoldItem[] = []
  for (const r of rows) {
    const terms = salientTerms(r.content, nTerms)
    if (terms.length >= 2) gold.push({ query: terms.join(" "), gold: [r.v] })
  }
  return gold
}

/** Top-N distinct content words by length (rare/specific terms first), boilerplate-free. */
function salientTerms(text: string, n: number): string[] {
  const seen = new Set<string>()
  const words: string[] = []
  for (const w of (text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])) {
    if (STOP.has(w) || seen.has(w)) continue
    seen.add(w)
    words.push(w)
  }
  return words.sort((a, b) => b.length - a.length).slice(0, n)
}
