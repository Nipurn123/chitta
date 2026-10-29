// Diversity cap + passage extraction - DISTINCT records first, then at most maxPerRecord
// chunks from any single record, with each surviving chunk reduced to its best matching passage.
//
// Two passes over the same ranked list. Pass 1 takes only each record's best chunk, so the top-k
// holds k DISTINCT records whenever the pool has that many: on pooled LongMemEval (940 sessions)
// letting a record take a second slot cost 5.9 points all-gold@10 at the same token budget,
// because a 2nd chunk of a session already returned can't add a new session. Pass 2 backfills
// further chunks per record (up to maxPerRecord) only when there aren't k distinct records - a
// small store still returns a long document's second matching section.
//
// Read-only: retrieval no longer records an "access". Doing so made every search boost what it
// returned (salience), so earlier queries biased later ones - see decay-stage.ts / markUsed.
import type { SearchResult } from "../../types"
import type { FusedResult } from "./fuse"
import { bestPassage, datedPassage, queryTokens } from "./passage"

export function diversityStage(
  ordered: FusedResult[],
  query: string,
  cutoff: number,
  maxPerRecord: number,
  topk: number,
): SearchResult[] {
  const terms = queryTokens(query)
  const keyOf = (r: SearchResult) => (r.metadata.point_id as string) ?? `${r.metadata.virtualRecordId ?? ""}|${r.content.slice(0, 80)}`
  const recKeyOf = (r: SearchResult) => (r.metadata.recordId as string) ?? (r.metadata.virtualRecordId as string) ?? keyOf(r)
  const perRecord = new Map<string, number>()
  const relevant: SearchResult[] = []
  const later: FusedResult[] = [] // chunks of records pass 1 already took, in rank order
  const take = (r: FusedResult, passage: string, recKey: string) => {
    perRecord.set(recKey, (perRecord.get(recKey) ?? 0) + 1)
    relevant.push({ score: r.score, citationType: r.citationType, content: datedPassage(r.content, passage), metadata: r.metadata })
  }

  for (const r of ordered) {
    if (relevant.length >= topk) break
    if (r.rrf < cutoff) continue
    const recKey = recKeyOf(r)
    if (perRecord.has(recKey)) {
      later.push(r)
      continue
    }
    // passage extraction: the exact matching line, not the whole digest chunk.
    // Empty ⇒ the chunk was all boilerplate (cookie/nav) ⇒ drop it entirely.
    const passage = bestPassage(r.content, terms)
    if (passage) take(r, passage, recKey)
  }

  for (const r of later) {
    if (relevant.length >= topk) break
    const recKey = recKeyOf(r)
    if ((perRecord.get(recKey) ?? 0) >= maxPerRecord) continue
    const passage = bestPassage(r.content, terms)
    if (passage) take(r, passage, recKey)
  }
  return relevant
}
