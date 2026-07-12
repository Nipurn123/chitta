// Diversity cap + passage extraction - no more than maxPerRecord chunks from any
// single record, with each surviving chunk reduced to its best matching passage.
import type { SqliteStore } from "../sqlite-store"
import type { SearchResult } from "../../types"
import type { FusedResult } from "./fuse"
import { bestPassage, queryTokens } from "./passage"

export function diversityStage(
  store: SqliteStore,
  ordered: FusedResult[],
  query: string,
  cutoff: number,
  maxPerRecord: number,
  topk: number,
  decayOn: boolean,
): SearchResult[] {
  const terms = queryTokens(query)
  const keyOf = (r: SearchResult) => (r.metadata.point_id as string) ?? `${r.metadata.virtualRecordId ?? ""}|${r.content.slice(0, 80)}`
  const perRecord = new Map<string, number>()
  const relevant: SearchResult[] = []
  for (const r of ordered) {
    if (r.rrf < cutoff) continue
    // passage extraction: the exact matching line, not the whole digest chunk.
    // Empty ⇒ the chunk was all boilerplate (cookie/nav) ⇒ drop it entirely.
    const passage = bestPassage(r.content, terms)
    if (!passage) continue
    const recKey = (r.metadata.recordId as string) ?? (r.metadata.virtualRecordId as string) ?? keyOf(r)
    const n = perRecord.get(recKey) ?? 0
    if (n >= maxPerRecord) continue
    perRecord.set(recKey, n + 1)
    relevant.push({ score: r.score, citationType: r.citationType, content: passage, metadata: r.metadata })
    if (relevant.length >= topk) break
  }
  // record the access (recency + frequency) of what we actually returned.
  if (decayOn) store.touchRecords([...new Set(relevant.map((r) => r.metadata.recordId as string).filter(Boolean))])
  return relevant
}
