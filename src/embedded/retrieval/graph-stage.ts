// Signal 3: GRAPH expansion (GraphRAG) - chunks reachable through related concepts.
import type { SqliteGraphProvider } from "../sqlite-graph-provider"
import type { SqliteStore } from "../sqlite-store"
import { embedQueryWith, type EmbeddingProvider } from "../../provider"
import type { AccessibleMap, SearchResult } from "../../types"
import { cosine } from "./passage"

export async function graphStage(
  graph: SqliteGraphProvider,
  store: SqliteStore,
  embeddings: EmbeddingProvider,
  query: string,
  orgId: string,
  dense: SearchResult[],
  accMap: AccessibleMap,
): Promise<SearchResult[]> {
  const graphList: SearchResult[] = []
  const seeds = [...new Set(dense.map((r) => r.metadata.recordId).filter(Boolean) as string[])]
  if (seeds.length) {
    const related = graph.getRelatedRecordIds(seeds, [...new Set(Object.values(accMap))], 5)
    if (related.length) {
      const q = await embedQueryWith(embeddings, query)
      const seen = new Set(dense.map((r) => r.metadata.virtualRecordId))
      const records = await graph.getRecordsByRecordIds(related, orgId)
      for (const rec of records) {
        const vid = (rec.virtualRecordId as string) ?? rec._key
        if (seen.has(vid)) continue
        const rows = store.db.query("SELECT content, embedding FROM chunks WHERE virtual_record_id = ?").all(vid) as Array<{ content: string; embedding: string }>
        let best: { content: string; score: number } | null = null
        for (const row of rows) {
          const s = cosine(q, JSON.parse(row.embedding) as number[])
          if (!best || s > best.score) best = { content: row.content, score: s }
        }
        if (best)
          graphList.push({
            score: best.score,
            citationType: "graph|related",
            content: best.content,
            metadata: { recordName: rec.recordName, recordId: rec._key, virtualRecordId: vid, orgId, origin: rec.origin, mimeType: rec.mimeType },
          })
      }
    }
  }
  return graphList
}
