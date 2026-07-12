// Reciprocal Rank Fusion (RRF) - fuse the dense/sparse/graph (+ optional PPR) signal
// lists into one ranked list with no score-scale calibration. RRF score = Σ 1/(k + rank)
// across the lists a chunk appears in (k=60), so a chunk strong in ANY signal surfaces,
// and one strong in several rises to the top.
import type { SqliteStore } from "../sqlite-store"
import type { AccessibleMap, SearchResult } from "../../types"

export type FusedResult = SearchResult & { rrf: number; legs: Set<string> }

export function rrfFuse(
  dense: SearchResult[],
  bm25: SearchResult[],
  graphList: SearchResult[],
  K: number,
  pprList: SearchResult[] = [], // 4th leg: PPR multi-hop (CONTEXT_GRAPH_PPR)
): FusedResult[] {
  const keyOf = (r: SearchResult) => (r.metadata.point_id as string) ?? `${r.metadata.virtualRecordId ?? ""}|${r.content.slice(0, 80)}`
  const fused = new Map<string, FusedResult>()
  // `leg` tags WHICH signal (vector / keyword / graph) found each item - captured for
  // the retrieval trace so the UI can show how a result was retrieved.
  const fuse = (list: SearchResult[], leg: string) =>
    list.forEach((r, i) => {
      const k = keyOf(r)
      const ex = fused.get(k)
      if (ex) {
        ex.rrf += 1 / (K + i + 1)
        ex.legs.add(leg)
        if (!ex.metadata.recordName && r.metadata.recordName) ex.metadata = { ...ex.metadata, ...r.metadata }
      } else fused.set(k, { ...r, rrf: 1 / (K + i + 1), legs: new Set([leg]) })
    })
  fuse(dense, "vector")
  fuse(bm25, "keyword")
  fuse(graphList, "graph")
  fuse(pprList, "ppr")
  return [...fused.values()]
}

// Union a SECOND fused list into the first (in place), adding rrf contributions for items
// already present and appending new ones - used to fold a pseudo-relevance-feedback (PRF)
// second-pass pool into the first pass. Same keying as rrfFuse so items align.
export function mergeFused(into: FusedResult[], extra: FusedResult[]): void {
  const keyOf = (r: FusedResult) => (r.metadata.point_id as string) ?? `${r.metadata.virtualRecordId ?? ""}|${r.content.slice(0, 80)}`
  const idx = new Map(into.map((r) => [keyOf(r), r]))
  for (const e of extra) {
    const k = keyOf(e)
    const ex = idx.get(k)
    if (ex) {
      ex.rrf += e.rrf
      for (const l of e.legs) ex.legs.add(l)
    } else {
      into.push(e)
      idx.set(k, e)
    }
  }
}

// Backfill recordName/recordId for BM25-only items (so citations resolve).
export function backfillMeta(store: SqliteStore, merged: FusedResult[], accMap: AccessibleMap): void {
  const needMeta = merged.filter((r) => !r.metadata.recordName && r.metadata.virtualRecordId)
  if (needMeta.length) {
    const want = [...new Set(needMeta.map((r) => accMap[r.metadata.virtualRecordId as string]).filter(Boolean) as string[])]
    const nameById = new Map<string, string>()
    if (want.length)
      for (const row of store.db
        .query(`SELECT id, json_extract(data,'$.recordName') n FROM nodes WHERE id IN (${want.map(() => "?").join(",")})`)
        .all(...want) as Array<{ id: string; n: string | null }>)
        nameById.set(row.id, row.n ?? "")
    for (const r of needMeta) {
      const rid = accMap[r.metadata.virtualRecordId as string]
      if (rid) r.metadata = { ...r.metadata, recordId: rid, recordName: nameById.get(rid) || r.metadata.recordName }
    }
  }
}
