// Signal 3: GRAPH expansion (GraphRAG) - chunks reachable through related concepts.
import type { SqliteGraphProvider } from "../sqlite-graph-provider"
import type { SqliteStore } from "../sqlite-store"
import { embedQueryWith, type EmbeddingProvider } from "../../provider"
import type { AccessibleMap, SearchResult } from "../../types"
import { cosine } from "./passage"
import { decodeF32 } from "../store/vector-blob"
import { extractKnowledge } from "../extract"

// Records that MENTION an entity NAMED IN THE QUERY - the entry point for multi-hop graph
// retrieval. The dense signal seeds expansion from what it lexically matched; this seeds it
// from the query's actual ENTITIES, so evidence reachable only through the typed graph (an
// entity → a fact about it in another record) becomes findable. Read-only resolution (alias
// lookup), ACL-filtered, so the query never mutates the graph and can't leak. Zero tokens.
function queryEntitySeeds(query: string, store: SqliteStore, accMap: AccessibleMap): string[] {
  const ids: string[] = []
  for (const e of extractKnowledge(query).entities) {
    const hit = store.entities.lookup(e.id)
    if (hit) ids.push(hit.canonicalId)
  }
  if (ids.length === 0) return []
  const rows = store.db
    .query(`SELECT DISTINCT src FROM edges WHERE label = 'mentions' AND dst IN (${ids.map(() => "?").join(",")})`)
    .all(...ids) as Array<{ src: string }>
  return rows.map((r) => r.src).filter((rid) => accMap[rid] != null) // ACL gate
}

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
  // Seed the expansion from BOTH the dense results AND the query's named entities (the latter
  // is what enables multi-hop). The query-seeded records are also candidates in their own right.
  const denseSeeds = dense.map((r) => r.metadata.recordId).filter(Boolean) as string[]
  const entitySeeds = queryEntitySeeds(query, store, accMap)
  const seeds = [...new Set([...denseSeeds, ...entitySeeds])]
  if (seeds.length) {
    const related = [...new Set([...graph.getRelatedRecordIds(seeds, [...new Set(Object.values(accMap))], 5), ...entitySeeds])]
    if (related.length) {
      const q = await embedQueryWith(embeddings, query)
      const seen = new Set(dense.map((r) => r.metadata.virtualRecordId))
      const records = await graph.getRecordsByRecordIds(related, orgId)
      for (const rec of records) {
        const vid = (rec.virtualRecordId as string) ?? rec._key
        if (seen.has(vid)) continue
        const rows = store.db.query("SELECT content, embedding FROM chunks WHERE virtual_record_id = ?").all(vid) as Array<{ content: string; embedding: Uint8Array | string }>
        let best: { content: string; score: number } | null = null
        for (const row of rows) {
          const s = cosine(q, decodeF32(row.embedding) as unknown as number[])
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
