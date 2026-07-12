// Retrieval trace - how a query flowed through the pipeline, for the UI's "how it
// retrieved" panel. counts = items each signal returned; items = the top fused/reranked
// results tagged with WHICH signals (vector / keyword / graph) found them.
import type { SearchResult } from "../../types"
import type { FusedResult } from "./fuse"

export interface SearchTrace {
  // `ppr` optional so existing constructors (and serialized traces) stay valid.
  counts: { vector: number; keyword: number; graph: number; fused: number; ppr?: number }
  reranked: boolean
  items: Array<{ label: string; recordId?: string; legs: string[]; rrf: number; rank: number }>
}

export function populateTrace(
  trace: SearchTrace,
  dense: SearchResult[],
  bm25: SearchResult[],
  graphList: SearchResult[],
  merged: FusedResult[],
  ordered: FusedResult[],
  rerankerUsed: boolean,
  pprList: SearchResult[] = [],
): void {
  trace.counts = { vector: dense.length, keyword: bm25.length, graph: graphList.length, fused: merged.length, ppr: pprList.length }
  trace.reranked = rerankerUsed
  trace.items = ordered.slice(0, 8).map((r, i) => ({
    label: (r.metadata.recordName as string) ?? (r.metadata.recordId as string) ?? "?",
    recordId: r.metadata.recordId as string,
    legs: [...r.legs],
    rrf: r.rrf,
    rank: i,
  }))
}
