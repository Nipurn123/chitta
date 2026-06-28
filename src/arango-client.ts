// ArangoClient adapter over ArangoDB's HTTP cursor API (no SDK dependency).
// Implements the single seam the ACL traversal needs: executeAql(query, bindVars),
// transparently following the cursor when results span multiple batches.

import type { ArangoClient } from "./provider"

export interface ArangoConfig {
  /** e.g. http://localhost:8529 */
  url: string
  database: string
  username?: string
  password?: string
  /** rows per cursor batch */
  batchSize?: number
  fetchImpl?: typeof fetch
}

interface CursorResponse {
  result: any[]
  hasMore: boolean
  id?: string
  error?: boolean
  errorMessage?: string
}

export class ArangoHttpClient implements ArangoClient {
  private readonly fetch: typeof fetch
  constructor(private readonly cfg: ArangoConfig) {
    this.fetch = cfg.fetchImpl ?? fetch
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" }
    if (this.cfg.username != null) {
      const basic = btoa(`${this.cfg.username}:${this.cfg.password ?? ""}`)
      h["authorization"] = `Basic ${basic}`
    }
    return h
  }

  private base(): string {
    return `${this.cfg.url.replace(/\/$/, "")}/_db/${encodeURIComponent(this.cfg.database)}`
  }

  async executeAql(query: string, bindVars: Record<string, unknown>): Promise<any[]> {
    const res = await this.fetch(`${this.base()}/_api/cursor`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ query, bindVars, batchSize: this.cfg.batchSize ?? 1000 }),
    })
    let body = (await res.json()) as CursorResponse
    if (body.error) throw new Error(`arango: ${body.errorMessage ?? res.status}`)

    const rows: any[] = [...body.result]
    // Drain the cursor - ACL queries can legitimately return many records.
    while (body.hasMore && body.id) {
      const next = await this.fetch(`${this.base()}/_api/cursor/${body.id}`, {
        method: "PUT",
        headers: this.headers(),
      })
      body = (await next.json()) as CursorResponse
      if (body.error) throw new Error(`arango cursor: ${body.errorMessage ?? next.status}`)
      rows.push(...body.result)
    }
    return rows
  }
}
