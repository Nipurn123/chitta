// VectorDBService over bun:sqlite. Uses the sqlite-vec ANN index when the store
// has it (fast path), else brute-force cosine - same results, same interface.
// Honors the must/should filter the retrieval spine builds: a point passes if it
// matches all `must` AND (no `should` OR matches a `should`). The `should` on
// virtualRecordId is the ACL restriction to accessible records, applied AFTER the
// ANN candidates come back (over-fetched) so recall holds under filtering.

import type { VectorDBService, VectorPoint, VectorQueryResult } from "../provider"
import type { SqliteStore } from "./sqlite-store"

interface EmbeddedFilter {
  must?: Record<string, unknown>
  should?: Record<string, unknown>
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export class SqliteVecService implements VectorDBService {
  constructor(private readonly store: SqliteStore) {}

  async filterCollection(args: {
    must?: Record<string, unknown>
    should?: Record<string, unknown>
  }): Promise<EmbeddedFilter> {
    return { must: args.must, should: args.should }
  }

  async queryNearestPoints(args: {
    collectionName: string
    requests: unknown[]
  }): Promise<VectorQueryResult[]> {
    return args.requests.map((reqUnknown) => {
      const req = reqUnknown as {
        prefetch?: Array<{ query: unknown; using?: string }>
        filter?: EmbeddedFilter
        limit?: number
      }
      const dense = (req.prefetch?.find((p) => p.using === "dense")?.query ?? req.prefetch?.[0]?.query) as number[]
      const filter = req.filter ?? {}
      const limit = req.limit ?? 20
      const mustOrg = filter.must?.["orgId"] as string | undefined
      const allowedVids = filter.should?.["virtualRecordId"] as string[] | undefined
      const allowed = allowedVids ? new Set(allowedVids) : undefined

      // Try ANN; fall back to brute-force when the index can't serve (missing /
      // not yet built / written by a non-vec store). Guarantees we never miss rows
      // that exist in `chunks` just because the ANN index isn't populated.
      let points = this.store.vecEnabled && dense ? this.annQuery(dense, mustOrg, allowed, limit) : []
      if (points.length === 0) points = this.bruteForce(dense, mustOrg, allowed, limit)
      return { points }
    })
  }

  // Fast path: ANN candidates from vec0, over-fetched then ACL-filtered.
  private annQuery(
    dense: number[],
    mustOrg: string | undefined,
    allowed: Set<string> | undefined,
    limit: number,
  ): VectorPoint[] {
    const knn = this.store.knnSearch(dense, Math.max(limit * 20, 50))
    if (knn.length === 0) return []
    const byRowid = new Map(knn.map((k) => [k.rowid, k.distance]))
    const rows = this.store.db
      .query(`SELECT rowid, point_id, virtual_record_id, org_id, content FROM chunks WHERE rowid IN (${knn.map(() => "?").join(",")})`)
      .all(...knn.map((k) => k.rowid)) as Array<{
      rowid: number
      point_id: string
      virtual_record_id: string
      org_id: string
      content: string
    }>
    const out: VectorPoint[] = []
    for (const c of rows) {
      if (mustOrg != null && c.org_id !== mustOrg) continue
      if (allowed && !allowed.has(c.virtual_record_id)) continue
      out.push({
        id: c.point_id,
        score: 1 - (byRowid.get(c.rowid) ?? 1), // cosine distance → similarity
        payload: { page_content: c.content, metadata: { virtualRecordId: c.virtual_record_id, orgId: c.org_id } },
      })
    }
    out.sort((a, b) => b.score - a.score)
    return out.slice(0, limit)
  }

  // Fallback: scan + cosine in TS (portable, no extension needed).
  private bruteForce(
    dense: number[] | undefined,
    mustOrg: string | undefined,
    allowed: Set<string> | undefined,
    limit: number,
  ): VectorPoint[] {
    const rows = this.store.db
      .query("SELECT point_id, virtual_record_id, org_id, content, embedding FROM chunks")
      .all() as Array<{ point_id: string; virtual_record_id: string; org_id: string; content: string; embedding: string }>
    const scored: VectorPoint[] = []
    for (const c of rows) {
      if (mustOrg != null && c.org_id !== mustOrg) continue
      if (allowed && !allowed.has(c.virtual_record_id)) continue
      scored.push({
        id: c.point_id,
        score: dense ? cosine(dense, JSON.parse(c.embedding) as number[]) : 0,
        payload: { page_content: c.content, metadata: { virtualRecordId: c.virtual_record_id, orgId: c.org_id } },
      })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }
}
