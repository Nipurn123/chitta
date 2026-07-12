// Signal 4: PPR multi-hop (HippoRAG-style Personalized PageRank over the entity graph).
//
// The graph stage's bounded hop reaches evidence ONE relation edge from the query's
// entities; this stage reaches evidence 2-3 edges out by spreading activation mass with
// restart (see graph/ppr.ts for the walk + its ACL fail-closed invariant). Fused as an
// extra RRF leg. NB: an extra leg is never free - its items compete for top-k slots, so
// it pays off only when its list is high-precision (hence typed-edges-only, seed-mention
// exclusion, and the small list cap). Flagged via CONTEXT_GRAPH_PPR. Zero tokens.
import type { SqliteGraphProvider } from "../sqlite-graph-provider"
import type { SqliteStore } from "../sqlite-store"
import { embedQueryWith, type EmbeddingProvider } from "../../provider"
import type { AccessibleMap, SearchResult } from "../../types"
import type { SqlAccess } from "../graph/sql-access"
import { pprRecordScores } from "../graph/ppr"
import { extractKnowledge } from "../extract"
import { cosine } from "./passage"
import { decodeF32 } from "../store/vector-blob"

// Default OFF - decided from measurement, not theory. LoCoMo Tier-A (k=10, real
// embeddings): the leg left multi-hop recall EXACTLY flat (0.314 -> 0.314 on the 3-case
// A/B) while costing ~2 pts single-hop and ~6ms/query. Why: LoCoMo "multi-hop" questions
// aggregate evidence across sessions that all mention the query's entities DIRECTLY -
// a ranking problem among 1-hop mentions, which walking FURTHER cannot fix, while the
// walk's extra candidates displace gold near the top-k boundary. The synthetic suite
// (test/embedded/ppr.test.ts) proves the mechanism itself: genuine 2-3-edge chains are
// found that the bounded hop provably cannot reach, ACL-fail-closed, hub-robust. Turn it
// ON (CONTEXT_GRAPH_PPR=1) for corpora whose graphs carry real typed chains - provided-
// graph ingestion (frontier-model triples), code graphs, org knowledge bases.
export function pprEnabled(): boolean {
  return /^(1|true|on)$/i.test(process.env.CONTEXT_GRAPH_PPR ?? "0")
}

// Query -> seed entity ids: the same read-only alias resolution the graph stage uses
// (extract entities from the query text, resolve each to its canonical id). No writes,
// so a query can never mutate the graph; ACL gating happens inside pprRecordScores.
function seedEntityIds(query: string, store: SqliteStore): string[] {
  const ids = new Set<string>()
  for (const e of extractKnowledge(query).entities) {
    const hit = store.entities.lookup(e.id)
    if (hit) ids.add(hit.canonicalId)
  }
  return [...ids]
}

export async function pprStage(
  graph: SqliteGraphProvider,
  store: SqliteStore,
  embeddings: EmbeddingProvider,
  query: string,
  orgId: string,
  dense: SearchResult[],
  accMap: AccessibleMap,
): Promise<SearchResult[]> {
  const seeds = seedEntityIds(query, store)
  if (seeds.length === 0) return []
  // The walk runs over raw SQL (same seam shape the provider hands its graph modules),
  // gated on the memoized accessible RECORD-id set - identical ACL source of truth as
  // the bounded hop, so the two graph legs can never disagree about visibility.
  const sql: SqlAccess = {
    rows: <T>(s: string, p: unknown[]) => store.db.query(s).all(...(p as any[])) as T[],
    ph: (nn: number) => Array.from({ length: nn }, () => "?").join(","),
  }
  const ranked = pprRecordScores(sql, seeds, graph.accessibleRidSet(accMap))
  if (ranked.length === 0) return []

  // Materialize records exactly like the graph stage: skip what dense already found
  // (this leg exists to ADD multi-hop reach, and identical materialization means a
  // record found by both graph legs fuses into one RRF entry, reinforcing it), then
  // surface each record's best chunk by cosine to the query.
  const q = await embedQueryWith(embeddings, query)
  const seen = new Set(dense.map((r) => r.metadata.virtualRecordId))
  const records = await graph.getRecordsByRecordIds(ranked.map((x) => x.recordId), orgId)
  const byId = new Map(records.map((rec) => [rec._key as string, rec]))
  const out: SearchResult[] = []
  for (const { recordId } of ranked) {
    // iterate in PPR-score order - the ORDER is the signal RRF consumes
    const rec = byId.get(recordId)
    if (!rec) continue
    const vid = (rec.virtualRecordId as string) ?? rec._key
    if (seen.has(vid)) continue
    const rows = store.db.query("SELECT content, embedding FROM chunks WHERE virtual_record_id = ?").all(vid) as Array<{
      content: string
      embedding: Uint8Array | string
    }>
    let best: { content: string; score: number } | null = null
    for (const row of rows) {
      const s = cosine(q, decodeF32(row.embedding) as unknown as number[])
      if (!best || s > best.score) best = { content: row.content, score: s }
    }
    if (best)
      out.push({
        score: best.score,
        citationType: "graph|ppr",
        content: best.content,
        metadata: { recordName: rec.recordName, recordId: rec._key, virtualRecordId: vid, orgId, origin: rec.origin, mimeType: rec.mimeType },
      })
  }
  return out
}
