// EmbeddingProvider adapter. Dense embeddings come from an OpenAI-compatible
// endpoint (PipesHub's air-gapped embedding server exposes /v1/embeddings); sparse
// (BM25) comes from a configurable sparse endpoint. Both over fetch - no SDK,
// nothing leaves the boundary if the endpoints are local.

import type { EmbeddingProvider } from "./provider"

export interface EmbeddingConfig {
  /** OpenAI-compatible base, e.g. http://localhost:8002 */
  denseEndpoint: string
  denseModel: string
  denseApiKey?: string
  /** Endpoint returning { indices, values } for a BM25/sparse vector. Optional;
   *  if absent, embedSparse throws (callers may run dense-only). */
  sparseEndpoint?: string
  fetchImpl?: typeof fetch
}

export class HttpEmbeddingProvider implements EmbeddingProvider {
  private readonly fetch: typeof fetch
  constructor(private readonly cfg: EmbeddingConfig) {
    this.fetch = cfg.fetchImpl ?? fetch
  }

  async embedDense(query: string): Promise<number[]> {
    const res = await this.fetch(`${this.cfg.denseEndpoint.replace(/\/$/, "")}/v1/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.cfg.denseApiKey ? { authorization: `Bearer ${this.cfg.denseApiKey}` } : {}),
      },
      body: JSON.stringify({ input: query, model: this.cfg.denseModel }),
    })
    const body = (await res.json()) as { data?: Array<{ embedding: number[] }>; error?: unknown }
    const embedding = body.data?.[0]?.embedding
    if (!embedding) throw new Error(`dense embed failed: ${JSON.stringify(body.error ?? res.status)}`)
    return embedding
  }

  async embedSparse(query: string): Promise<{ indices: number[]; values: number[] }> {
    if (!this.cfg.sparseEndpoint) throw new Error("no sparse endpoint configured")
    const res = await this.fetch(this.cfg.sparseEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: query }),
    })
    const body = (await res.json()) as { indices?: number[]; values?: number[] }
    if (!body.indices || !body.values) throw new Error(`sparse embed failed: ${res.status}`)
    return { indices: body.indices, values: body.values }
  }
}
