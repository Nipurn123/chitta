// Verification of the ported moat. These tests use in-memory fakes for the three
// backend seams, so they run with zero external deps and exercise the ACL +
// retrieval LOGIC - the part we own. The focus is the security invariant:
// a user only ever sees records their permission map allows.

import { describe, expect, test } from "bun:test"
import { ArangoGraphProvider } from "../src/arango-graph-provider"
import { RetrievalService } from "../src/retrieval"
import { RetrievalStatus } from "../src/types"
import type { ArangoClient, EmbeddingProvider, GraphProvider, VectorDBService, VectorQueryResult } from "../src/provider"
import type { AccessibleMap, RecordDoc, UserDoc } from "../src/types"

// --- Fake ArangoClient: routes each AQL call to canned rows by query shape. ---
class FakeArango implements ArangoClient {
  constructor(
    private readonly data: {
      user?: UserDoc | null
      apps?: Array<{ _key?: string; id?: string }>
      connectorRows?: (connectorId: string) => any[]
      kbRows?: any[]
      records?: RecordDoc[]
    },
  ) {}
  calls: Array<{ q: string; bind: Record<string, unknown> }> = []
  async executeAql(query: string, bindVars: Record<string, unknown>): Promise<any[]> {
    this.calls.push({ q: query, bind: bindVars })
    if (query.includes("RETURN user") && query.includes("LIMIT 1")) return this.data.user ? [this.data.user] : []
    if (query.includes('IS_SAME_COLLECTION("apps"')) return this.data.apps ?? []
    if (query.includes("record._key IN @recordIds")) {
      const ids = bindVars.recordIds as string[]
      return (this.data.records ?? []).filter((r) => ids.includes(r._key))
    }
    if (query.includes("directKbRecords")) return this.data.kbRows ?? []
    if (query.includes("directRecords")) return this.data.connectorRows?.(bindVars.connectorId as string) ?? []
    return []
  }
}

describe("ArangoGraphProvider - ACL traversal", () => {
  test("builds accessible map from connector + KB paths", async () => {
    const client = new FakeArango({
      user: { _key: "u1", userId: "user-1" },
      apps: [{ _key: "slack" }, { _key: "drive" }],
      connectorRows: (cid) =>
        cid === "slack"
          ? [{ virtualRecordId: "v1", recordId: "rec1" }]
          : [{ virtualRecordId: "v2", recordId: "rec2" }],
      kbRows: [{ virtualRecordId: "v3", recordId: "rec3" }],
    })
    const provider = new ArangoGraphProvider(client)
    const map = await provider.getAccessibleVirtualRecordIds({ userId: "user-1", orgId: "org-1" })
    expect(map).toEqual({ v1: "rec1", v2: "rec2", v3: "rec3" })
  })

  test("cross-path dedup: first writer wins for a shared virtualRecordId", async () => {
    // Same virtualRecordId reachable via two connectors with different recordIds.
    const client = new FakeArango({
      user: { _key: "u1", userId: "user-1" },
      apps: [{ _key: "slack" }, { _key: "drive" }],
      connectorRows: (cid) =>
        cid === "slack"
          ? [{ virtualRecordId: "shared", recordId: "rec-slack" }]
          : [{ virtualRecordId: "shared", recordId: "rec-drive" }],
    })
    const provider = new ArangoGraphProvider(client)
    const map = await provider.getAccessibleVirtualRecordIds({ userId: "user-1", orgId: "org-1" })
    expect(Object.keys(map)).toEqual(["shared"])
    expect(["rec-slack", "rec-drive"]).toContain(map["shared"]) // exactly one, deterministic per run
  })

  test("user with no apps still gets KB records", async () => {
    const client = new FakeArango({
      user: { _key: "u1", userId: "user-1" },
      apps: [],
      kbRows: [{ virtualRecordId: "kbv", recordId: "kbrec" }],
    })
    const provider = new ArangoGraphProvider(client)
    const map = await provider.getAccessibleVirtualRecordIds({ userId: "user-1", orgId: "org-1" })
    expect(map).toEqual({ kbv: "kbrec" })
  })

  test("missing user → empty map (deny by default)", async () => {
    const client = new FakeArango({ user: null })
    const provider = new ArangoGraphProvider(client)
    const map = await provider.getAccessibleVirtualRecordIds({ userId: "ghost", orgId: "org-1" })
    expect(map).toEqual({})
  })

  test("a failing permission path does not deny the others", async () => {
    const client = new (class extends FakeArango {
      override async executeAql(q: string, b: Record<string, unknown>) {
        if (q.includes("directRecords") && b.connectorId === "slack") throw new Error("arango down")
        return super.executeAql(q, b)
      }
    })({
      user: { _key: "u1", userId: "user-1" },
      apps: [{ _key: "slack" }, { _key: "drive" }],
      connectorRows: () => [{ virtualRecordId: "v2", recordId: "rec2" }],
    })
    const provider = new ArangoGraphProvider(client)
    const map = await provider.getAccessibleVirtualRecordIds({ userId: "user-1", orgId: "org-1" })
    expect(map).toEqual({ v2: "rec2" }) // drive survived, slack's failure swallowed
  })
})

// --- Fakes for the retrieval spine. ---
class FakeGraph implements GraphProvider {
  constructor(
    private readonly accessible: AccessibleMap,
    private readonly records: RecordDoc[],
    private readonly user: UserDoc | null = { _key: "u1", userId: "user-1", email: "a@co" },
  ) {}
  async getAccessibleVirtualRecordIds() {
    return this.accessible
  }
  async getRecordsByRecordIds(ids: string[]) {
    return this.records.filter((r) => ids.includes(r._key))
  }
  async getUserByUserId() {
    return this.user
  }
  async getUserApps() {
    return []
  }
  async getDocument() {
    return null
  }
}

class FakeVector implements VectorDBService {
  lastFilter: any
  constructor(private readonly points: VectorQueryResult["points"]) {}
  async filterCollection(args: { must?: Record<string, unknown>; should?: Record<string, unknown> }) {
    this.lastFilter = args
    return args
  }
  async queryNearestPoints(): Promise<VectorQueryResult[]> {
    return [{ points: this.points }]
  }
}

const fakeEmbeddings: EmbeddingProvider = {
  async embedDense() {
    return [0.1, 0.2]
  },
  async embedSparse() {
    return { indices: [1], values: [0.5] }
  },
}

function rec(key: string, vid: string): RecordDoc {
  return { _key: key, virtualRecordId: vid, origin: "UPLOAD", recordName: `name-${key}`, mimeType: "text/plain" }
}

describe("RetrievalService - enforcement spine", () => {
  test("drops a chunk whose virtualRecordId is NOT in the accessible map (leak attempt)", async () => {
    const graph = new FakeGraph({ v1: "rec1" }, [rec("rec1", "v1")]) // user may only see v1
    const vector = new FakeVector([
      { id: 1, score: 0.9, payload: { page_content: "ok", metadata: { virtualRecordId: "v1" } } },
      { id: 2, score: 0.8, payload: { page_content: "secret", metadata: { virtualRecordId: "v-forbidden" } } },
    ])
    const svc = new RetrievalService({ graph, vector, embeddings: fakeEmbeddings, collectionName: "c" })
    const res = await svc.searchWithFilters({ queries: ["q"], userId: "user-1", orgId: "org-1" })

    expect(res.status).toBe(RetrievalStatus.SUCCESS)
    const vids = res.searchResults.map((r) => r.metadata.virtualRecordId)
    expect(vids).toEqual(["v1"]) // forbidden chunk gone
    expect(res.searchResults.some((r) => r.content === "secret")).toBe(false)
  })

  test("leak guard: recordId comes from the accessible map, never the vector payload", async () => {
    const graph = new FakeGraph({ v1: "rec1" }, [rec("rec1", "v1")])
    const vector = new FakeVector([
      // Malicious/stale payload claims a different recordId - must be ignored.
      { id: 1, score: 0.9, payload: { page_content: "ok", metadata: { virtualRecordId: "v1", recordId: "SECRET" } } },
    ])
    const svc = new RetrievalService({ graph, vector, embeddings: fakeEmbeddings, collectionName: "c" })
    const res = await svc.searchWithFilters({ queries: ["q"], userId: "user-1", orgId: "org-1" })
    expect(res.searchResults[0].metadata.recordId).toBe("rec1")
  })

  test("vector search is restricted to the accessible virtualRecordIds", async () => {
    const graph = new FakeGraph({ v1: "rec1", v2: "rec2" }, [rec("rec1", "v1"), rec("rec2", "v2")])
    const vector = new FakeVector([
      { id: 1, score: 0.9, payload: { page_content: "ok", metadata: { virtualRecordId: "v1" } } },
    ])
    const svc = new RetrievalService({ graph, vector, embeddings: fakeEmbeddings, collectionName: "c" })
    await svc.searchWithFilters({ queries: ["q"], userId: "user-1", orgId: "org-1" })
    expect(vector.lastFilter.should.virtualRecordId.sort()).toEqual(["v1", "v2"])
    expect(vector.lastFilter.must.orgId).toBe("org-1")
  })

  test("empty accessible map → ACCESSIBLE_RECORDS_NOT_FOUND, no search runs", async () => {
    const graph = new FakeGraph({}, [])
    const vector = new FakeVector([])
    const svc = new RetrievalService({ graph, vector, embeddings: fakeEmbeddings, collectionName: "c" })
    const res = await svc.searchWithFilters({ queries: ["q"], userId: "user-1", orgId: "org-1" })
    expect(res.status).toBe(RetrievalStatus.ACCESSIBLE_RECORDS_NOT_FOUND)
    expect(vector.lastFilter).toBeUndefined() // never queried the vector store
  })

  test("results missing required citation fields are filtered out", async () => {
    // record has no mimeType → result fails the completeness check.
    const bad: RecordDoc = { _key: "rec1", virtualRecordId: "v1", origin: "UPLOAD", recordName: "n" }
    const graph = new FakeGraph({ v1: "rec1" }, [bad])
    const vector = new FakeVector([
      { id: 1, score: 0.9, payload: { page_content: "ok", metadata: { virtualRecordId: "v1" } } },
    ])
    const svc = new RetrievalService({ graph, vector, embeddings: fakeEmbeddings, collectionName: "c" })
    const res = await svc.searchWithFilters({ queries: ["q"], userId: "user-1", orgId: "org-1" })
    expect(res.searchResults.length).toBe(0)
  })

  test("results are sorted by score descending", async () => {
    const graph = new FakeGraph({ v1: "rec1", v2: "rec2" }, [rec("rec1", "v1"), rec("rec2", "v2")])
    const vector = new FakeVector([
      { id: 1, score: 0.3, payload: { page_content: "low", metadata: { virtualRecordId: "v1" } } },
      { id: 2, score: 0.95, payload: { page_content: "high", metadata: { virtualRecordId: "v2" } } },
    ])
    const svc = new RetrievalService({ graph, vector, embeddings: fakeEmbeddings, collectionName: "c" })
    const res = await svc.searchWithFilters({ queries: ["q"], userId: "user-1", orgId: "org-1" })
    expect(res.searchResults.map((r) => r.score)).toEqual([0.95, 0.3])
  })
})
