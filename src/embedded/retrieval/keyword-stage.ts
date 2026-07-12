// Signal 2: SPARSE (BM25 / FTS5) - exact tokens dense misses (acronyms "SAP", "£230M").
// ACL-filtered to accessible records, fts rank order kept.
import type { SqliteStore } from "../sqlite-store"
import type { SearchResult } from "../../types"

export function keywordStage(
  store: SqliteStore,
  query: string,
  orgId: string,
  accessibleVids: ReadonlySet<string>,
  retrieveLimit: number,
): SearchResult[] {
  const bm25: SearchResult[] = []
  const ftsRowids = store.ftsSearch(query, retrieveLimit)
  if (ftsRowids.length) {
    const rows = store.db
      .query(`SELECT rowid, point_id, virtual_record_id v, org_id o, content FROM chunks WHERE rowid IN (${ftsRowids.map(() => "?").join(",")})`)
      .all(...ftsRowids) as Array<{ rowid: number; point_id: string; v: string; o: string; content: string }>
    const byRow = new Map(rows.map((r) => [r.rowid, r]))
    for (const rid of ftsRowids) {
      const r = byRow.get(rid)
      if (!r || r.o !== orgId || !accessibleVids.has(r.v)) continue // ACL
      bm25.push({ score: 0, citationType: "bm25", content: r.content, metadata: { virtualRecordId: r.v, orgId, point_id: r.point_id } })
    }
  }
  return bm25
}
