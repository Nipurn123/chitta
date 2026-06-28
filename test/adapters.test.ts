// Adapter verification with a mocked fetch - no live Arango/Qdrant/embedding
// server needed. Confirms the HTTP shaping the moat depends on: cursor draining,
// Qdrant filter/batch shaping, and embedding request/response handling.

import { describe, expect, test } from "bun:test"
import { ArangoHttpClient } from "../src/arango-client"
import { QdrantVectorService } from "../src/qdrant-vector"
import { HttpEmbeddingProvider } from "../src/embeddings"

type Handler = (url: string, init: RequestInit) => { status?: number; ok?: boolean; body: unknown }
function mockFetch(handler: Handler): typeof fetch {
  return (async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url
    const { status = 200, ok = true, body } = handler(url, init)
    return { ok, status, json: async () => body } as Response
  }) as unknown as typeof fetch
}

describe("ArangoHttpClient", () => {
  test("drains a multi-batch cursor into one result array", async () => {
    let putCount = 0
    const fetchImpl = mockFetch((_url, init) => {
      if (init.method === "POST") return { body: { result: [1, 2], hasMore: true, id: "cur1", error: false } }
      putCount++ // PUT to continue the cursor
      return { body: { result: [3, 4], hasMore: false, error: false } }
    })
    const client = new ArangoHttpClient({ url: "http://a:8529", database: "db", fetchImpl })
    const rows = await client.executeAql("FOR x IN c RETURN x", {})
    expect(rows).toEqual([1, 2, 3, 4])
    expect(putCount).toBe(1)
  })

  test("throws on arango error payload", async () => {
    const fetchImpl = mockFetch(() => ({ body: { result: [], hasMore: false, error: true, errorMessage: "bad aql" } }))
    const client = new ArangoHttpClient({ url: "http://a:8529", database: "db", fetchImpl })
    await expect(client.executeAql("nope", {})).rejects.toThrow("bad aql")
  })

  test("sends basic auth when credentials given", async () => {
    let seenAuth: string | undefined
    const fetchImpl = mockFetch((_url, init) => {
      seenAuth = (init.headers as Record<string, string>)["authorization"]
      return { body: { result: [], hasMore: false, error: false } }
    })
    const client = new ArangoHttpClient({ url: "http://a:8529", database: "db", username: "root", password: "pw", fetchImpl })
    await client.executeAql("RETURN 1", {})
    expect(seenAuth).toBe(`Basic ${btoa("root:pw")}`)
  })
})

describe("QdrantVectorService", () => {
  test("filterCollection builds prefixed must/should match conditions", async () => {
    const svc = new QdrantVectorService({ url: "http://q:6333", fetchImpl: mockFetch(() => ({ body: {} })) })
    const filter = (await svc.filterCollection({
      must: { orgId: "org-1" },
      should: { virtualRecordId: ["v1", "v2"] },
    })) as any
    expect(filter.must).toEqual([{ key: "metadata.orgId", match: { value: "org-1" } }])
    expect(filter.should).toEqual([{ key: "metadata.virtualRecordId", match: { any: ["v1", "v2"] } }])
  })

  test("queryNearestPoints posts batch and maps results to points", async () => {
    let sentBody: any
    const fetchImpl = mockFetch((url, init) => {
      expect(url).toContain("/collections/myc/points/query/batch")
      sentBody = JSON.parse(init.body as string)
      return { body: { result: [{ points: [{ id: 1, score: 0.9, payload: { page_content: "x" } }] }] } }
    })
    const svc = new QdrantVectorService({ url: "http://q:6333", fetchImpl })
    const out = await svc.queryNearestPoints({ collectionName: "myc", requests: [{ query: { fusion: "RRF" } }] })
    expect(sentBody.searches).toHaveLength(1)
    expect(out[0].points[0].score).toBe(0.9)
  })

  test("throws on non-ok qdrant response", async () => {
    const fetchImpl = mockFetch(() => ({ ok: false, status: 500, body: { status: "err" } }))
    const svc = new QdrantVectorService({ url: "http://q:6333", fetchImpl })
    await expect(svc.queryNearestPoints({ collectionName: "c", requests: [] })).rejects.toThrow("qdrant query failed")
  })
})

describe("HttpEmbeddingProvider", () => {
  test("dense embed hits /v1/embeddings and returns the vector", async () => {
    const fetchImpl = mockFetch((url, init) => {
      expect(url).toContain("/v1/embeddings")
      expect(JSON.parse(init.body as string).model).toBe("bge-small")
      return { body: { data: [{ embedding: [0.1, 0.2, 0.3] }] } }
    })
    const emb = new HttpEmbeddingProvider({ denseEndpoint: "http://e:8002", denseModel: "bge-small", fetchImpl })
    expect(await emb.embedDense("hi")).toEqual([0.1, 0.2, 0.3])
  })

  test("sparse embed throws when no sparse endpoint configured", async () => {
    const emb = new HttpEmbeddingProvider({ denseEndpoint: "http://e", denseModel: "m", fetchImpl: mockFetch(() => ({ body: {} })) })
    await expect(emb.embedSparse("hi")).rejects.toThrow("no sparse endpoint")
  })
})
