// VectorDBService adapter over Qdrant's HTTP API (no SDK dependency).
// `filterCollection` builds a Qdrant filter; `queryNearestPoints` runs the hybrid
// (dense + sparse, RRF) batch query the retrieval spine assembles.

import type { VectorDBService, VectorQueryResult } from "./provider"

export interface QdrantConfig {
  /** e.g. http://localhost:6333 */
  url: string
  apiKey?: string
  /** payload key prefix for metadata fields (Qdrant stores them under `metadata`). */
  metadataPrefix?: string
  fetchImpl?: typeof fetch
}

/** Qdrant filter condition: match any of the given values for a payload key. */
interface QdrantCondition {
  key: string
  match: { any: unknown[] } | { value: unknown }
}
interface QdrantFilter {
  must?: QdrantCondition[]
  should?: QdrantCondition[]
}

export class QdrantVectorService implements VectorDBService {
  private readonly fetch: typeof fetch
  private readonly prefix: string
  constructor(private readonly cfg: QdrantConfig) {
    this.fetch = cfg.fetchImpl ?? fetch
    this.prefix = cfg.metadataPrefix ?? "metadata."
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" }
    if (this.cfg.apiKey) h["api-key"] = this.cfg.apiKey
    return h
  }

  private conditions(spec?: Record<string, unknown>): QdrantCondition[] {
    if (!spec) return []
    return Object.entries(spec).map(([key, val]) => ({
      key: `${this.prefix}${key}`,
      match: Array.isArray(val) ? { any: val } : { value: val },
    }))
  }

  async filterCollection(args: {
    must?: Record<string, unknown>
    should?: Record<string, unknown>
  }): Promise<QdrantFilter> {
    const filter: QdrantFilter = {}
    const must = this.conditions(args.must)
    const should = this.conditions(args.should)
    if (must.length) filter.must = must
    if (should.length) filter.should = should
    return filter
  }

  async queryNearestPoints(args: {
    collectionName: string
    requests: unknown[]
  }): Promise<VectorQueryResult[]> {
    const url = `${this.cfg.url.replace(/\/$/, "")}/collections/${encodeURIComponent(
      args.collectionName,
    )}/points/query/batch`
    const res = await this.fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ searches: args.requests }),
    })
    const body = (await res.json()) as { result?: Array<{ points: VectorQueryResult["points"] }>; status?: unknown }
    if (!res.ok) throw new Error(`qdrant query failed: ${res.status} ${JSON.stringify(body.status)}`)
    return (body.result ?? []).map((r) => ({ points: r.points ?? [] }))
  }
}
