// VectorDBService over bun:sqlite. Uses the sqlite-vec ANN index when the store
// has it (fast path), else brute-force cosine - same results, same interface.
// Honors the must/should filter the retrieval spine builds: a point passes if it
// matches all `must` AND (no `should` OR matches a `should`). The `should` on
// virtualRecordId is the ACL restriction to accessible records, applied AFTER the
// ANN candidates come back (over-fetched) so recall holds under filtering.

import type { VectorDBService, VectorPoint, VectorQueryResult } from "../provider"
import type { SqliteStore } from "./sqlite-store"
import { decodeF32, dot, normalize, TopK } from "./store/vector-blob"

interface EmbeddedFilter {
  must?: Record<string, unknown>
  should?: Record<string, unknown>
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
      // Prefer the pre-built (memoized) ACL set threaded from the retrieval spine - avoids an
      // O(N) Set rebuild per query. Fall back to the id array (cloud filter shape).
      const allowedSet = filter.should?.["virtualRecordIdSet"] as ReadonlySet<string> | undefined
      const allowedVids = filter.should?.["virtualRecordId"] as string[] | undefined
      const allowed = allowedSet ?? (allowedVids ? new Set(allowedVids) : undefined)

      // FILTERED-ANN (ACORN / Filtered-DiskANN principle): when the ACL filter is SELECTIVE - the
      // user can see only a bounded set - make the permission set the SEARCH SPACE. Scanning
      // exactly those vectors is cheaper (O(accessible) via idx_chunks_vid) AND higher-recall
      // (EXACT - no over-fetched global ANN that returns mostly-inaccessible rows and truncates the
      // accessible ones). The permission gate stops being a post-filter and becomes the candidate
      // generator. Above the threshold (e.g. an admin who sees everything) we keep the ANN path.
      const ff = Number(process.env.CONTEXT_FILTER_FIRST_MAX ?? 2000)
      if (dense && allowed && allowed.size > 0 && allowed.size <= ff) {
        return { points: this.filteredExact(dense, mustOrg, allowed, limit) }
      }

      // Try ANN (vec0 plaintext OR libSQL native DiskANN under encryption); fall back to
      // the fast BLOB brute-force when the index can't serve (missing / not yet built /
      // written by a non-vec store). Guarantees we never miss rows that exist in `chunks`.
      let points = this.store.annEnabled && dense ? this.annQuery(dense, mustOrg, allowed, limit) : []
      if (points.length === 0) points = this.bruteForce(dense, mustOrg, allowed, limit)
      return { points }
    })
  }

  // Fast path: ANN candidates from vec0, over-fetched then ACL-filtered.
  private annQuery(
    dense: number[],
    mustOrg: string | undefined,
    allowed: ReadonlySet<string> | undefined,
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

  // FILTERED-ANN fast path: EXACT top-k over ONLY the accessible chunks. Bounded by |accessible|
  // (fetched via idx_chunks_vid), so O(accessible) not O(all chunks) - and exact, so a scoped user
  // never loses a relevant hit to ANN over-fetch truncation. IN-list is chunked under SQLite's
  // variable cap. Same scoring (dot on unit-normalized vectors == cosine) as the other paths.
  private filteredExact(dense: number[], mustOrg: string | undefined, allowed: ReadonlySet<string>, limit: number): VectorPoint[] {
    const vids = [...allowed]
    const q = normalize(dense)
    const top = new TopK<{ point_id: string; content: string; vid: string; org: string }>(limit)
    const CH = 900 // stay well under SQLite's default variable limit
    for (let i = 0; i < vids.length; i += CH) {
      const slice = vids.slice(i, i + CH)
      const rows = this.store.db
        .query(
          `SELECT point_id, virtual_record_id, org_id, content, embedding FROM chunks WHERE virtual_record_id IN (${slice.map(() => "?").join(",")})`,
        )
        .all(...slice) as Array<{ point_id: string; virtual_record_id: string; org_id: string; content: string; embedding: Uint8Array | string }>
      for (const c of rows) {
        if (mustOrg != null && c.org_id !== mustOrg) continue
        top.offer(dot(q, decodeF32(c.embedding)), { point_id: c.point_id, content: c.content, vid: c.virtual_record_id, org: c.org_id })
      }
    }
    return top.values().map(({ score, value }) => ({
      id: value.point_id,
      score,
      payload: { page_content: value.content, metadata: { virtualRecordId: value.vid, orgId: value.org } },
    }))
  }

  // Fallback: scan in TS (portable, no extension needed) - but fast. Embeddings are read
  // as Float32 BLOBs (zero-copy, no JSON.parse), scored by dot product against the
  // unit-normalized query (dot == cosine for our normalized embedders), and only the top-k
  // are kept via a bounded selector (no full O(N log N) sort of the whole corpus).
  private bruteForce(
    dense: number[] | undefined,
    mustOrg: string | undefined,
    allowed: ReadonlySet<string> | undefined,
    limit: number,
  ): VectorPoint[] {
    if (!dense) return []
    const q = normalize(dense)
    const rows = this.store.db
      .query("SELECT point_id, virtual_record_id, org_id, content, embedding FROM chunks")
      .all() as Array<{ point_id: string; virtual_record_id: string; org_id: string; content: string; embedding: Uint8Array | string }>
    const top = new TopK<{ point_id: string; content: string; vid: string; org: string }>(limit)
    for (const c of rows) {
      if (mustOrg != null && c.org_id !== mustOrg) continue
      if (allowed && !allowed.has(c.virtual_record_id)) continue
      top.offer(dot(q, decodeF32(c.embedding)), { point_id: c.point_id, content: c.content, vid: c.virtual_record_id, org: c.org_id })
    }
    return top.values().map(({ score, value }) => ({
      id: value.point_id,
      score,
      payload: { page_content: value.content, metadata: { virtualRecordId: value.vid, orgId: value.org } },
    }))
  }
}
