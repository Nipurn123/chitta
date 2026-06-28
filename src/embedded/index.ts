// Embedded context stack: one SQLite file, in-process embeddings, zero servers.
// Wires the same RetrievalService (the moat) over embedded adapters - this is the
// single-binary path. `bun build --compile` over a CLI that calls this yields one
// self-contained executable.

import { RetrievalService } from "../retrieval"
import { SqliteStore } from "./sqlite-store"
import { SqliteGraphProvider } from "./sqlite-graph-provider"
import { SqliteVecService } from "./sqlite-vec-service"
import { LocalHashEmbeddings } from "./local-embeddings"
import { TransformersEmbeddings, AutoEmbeddings } from "./transformers-embeddings"
import { Ingestor, type IngestDoc } from "./ingest"
import { DeterministicExtractor, slugify, entityId, type KnowledgeExtractor } from "./extract"
import { Authorizer } from "./authorizer"
import { KgqaService } from "./kgqa-service"
import { GraphQueryService } from "./graph-query"
import type { Reranker } from "./reranker"
import type { LlmExtractor } from "./llm-extractor"
import type { EmbeddingProvider } from "../provider"
import type { RetrievalResponse } from "../types"
import { hybridSearch } from "./retrieval/hybrid-retriever"
import { cosine } from "./retrieval/passage"
import type { SearchTrace } from "./retrieval/trace"

/** A current memory surfaced to a caller (latest version, not forgotten), ACL-scoped. */
export interface RecalledMemory {
  memory: string
  version: number
  isStatic: boolean
  updatedAt: number
  rootId: string
}

/** A synthesized, ACL-scoped profile of one subject - the permanent facts, the recent
 *  (dynamic) facts, and the entities it's most connected to. Supermemory's "user profile",
 *  but for ANY principal/entity the caller is permitted to see, not just the caller. */
export interface Profile {
  subject: string
  staticFacts: string[]
  recentFacts: string[]
  related: string[]
}

export { SqliteStore } from "./sqlite-store"
export { SqliteGraphProvider } from "./sqlite-graph-provider"
export { SqliteVecService } from "./sqlite-vec-service"
export { LocalHashEmbeddings } from "./local-embeddings"
export { TransformersEmbeddings } from "./transformers-embeddings"
export { Ingestor, chunkText, type IngestDoc } from "./ingest"
export { DeterministicExtractor, type KnowledgeExtractor } from "./extract"
export { LlmExtractor, HybridExtractor } from "./llm-extractor"
export { Authorizer, AuthorizationError, type Role } from "./authorizer"

export interface EmbeddedOptions {
  path?: string
  collectionName?: string
  embeddings?: EmbeddingProvider
  extractor?: KnowledgeExtractor
  llm?: LlmExtractor // enables LLM-based KGQA intent parsing
  reranker?: Reranker // optional cross-encoder final stage (highest-precision reorder)
  log?: { info: (m: string) => void; debug: (m: string) => void; error: (m: string) => void }
}

// Retrieval trace - how a query flowed through the pipeline, for the UI's "how it
// retrieved" panel. Defined in retrieval/trace.ts; re-exported here as part of the
// public API.
export type { SearchTrace } from "./retrieval/trace"

// Default embedder selection (when the caller doesn't pass one). Controlled by
// CONTEXT_EMBEDDINGS: "auto" (default) = real semantic embeddings when transformers.js
// can load, else the offline keyword-hash fallback; "real"/"transformers" = force real;
// "hash"/"local" = force the deterministic hashing embedder (used by the test suite via
// bunfig preload, so tests never download a model). CONTEXT_EMBED_MODEL overrides the model.
// NOTE: a given DB is tied to ONE embedder's vector space — don't switch embedders on an
// existing DB (dims differ); reindex if you change modes.
export function defaultEmbeddings(): EmbeddingProvider {
  const mode = (process.env.CONTEXT_EMBEDDINGS ?? "auto").toLowerCase()
  const model = process.env.CONTEXT_EMBED_MODEL || undefined
  if (mode === "hash" || mode === "local") return new LocalHashEmbeddings()
  if (mode === "real" || mode === "transformers") return new TransformersEmbeddings(model)
  return new AutoEmbeddings(model)
}

export function buildEmbeddedContext(opts: EmbeddedOptions = {}) {
  const store = new SqliteStore(opts.path ?? ":memory:")
  const graph = new SqliteGraphProvider(store)
  const vector = new SqliteVecService(store)
  const embeddings = opts.embeddings ?? defaultEmbeddings()
  const extractor = opts.extractor ?? new DeterministicExtractor()
  const retrieval = new RetrievalService({
    graph,
    vector,
    embeddings,
    collectionName: opts.collectionName ?? "records",
    log: opts.log,
  })
  const ingestor = new Ingestor(store, embeddings, extractor)
  const authorizer = new Authorizer(store)
  const kgqa = new KgqaService(graph, store, embeddings, opts.llm)
  const graphQuery = new GraphQueryService(graph)
  const reranker = opts.reranker // optional cross-encoder final stage

  // Exact-answer first: try to answer the question precisely from the typed graph;
  // returns null when it can't (caller then falls back to ranked retrieval).
  async function ask(question: string, userId: string, orgId: string) {
    return kgqa.answer(question, userId, orgId)
  }

  // Self-heal embedder/dim drift: a DB is tied to ONE embedder's vector space. If the
  // stored vectors were written by a different embedder than the one now active (e.g. the
  // default flipped to real embeddings, or transformers can't load and it fell back to
  // hashing), the dims won't match — which would crash the ANN insert and corrupt cosine.
  // We detect the change once and reindex the whole DB to the CURRENT embedder. Runs at
  // most once per process; never blocks (failures are swallowed, ingest/query proceed).
  let reconcilePromise: Promise<void> | null = null
  function reconcile(): Promise<void> {
    return (reconcilePromise ??= (async () => {
      try {
        const row = store.db
          .query("SELECT embedding FROM chunks WHERE embedding IS NOT NULL LIMIT 1")
          .get() as { embedding: string } | undefined
        if (!row) return // empty DB → the current embedder defines the vector space
        const storedDim = (JSON.parse(row.embedding) as number[]).length
        const curDim = (await embeddings.embedDense("dimension probe")).length
        if (storedDim !== curDim) {
          opts.log?.error(
            `[chitta] embedder changed for this DB (${storedDim}d → ${curDim}d); reindexing all chunks to the current embedder`,
          )
          await reindex()
        }
      } catch {
        /* never block ingest/query on reconcile */
      }
    })())
  }

  // Authorized write path: checks the acting user MAY create + may grant the
  // requested sharing, stamps ownership, then ingests. Throws AuthorizationError.
  async function authorizedIngest(actingUserId: string, doc: IngestDoc) {
    await reconcile() // heal embedder/dim drift before writing new vectors
    authorizer.assertCanCreate(actingUserId, doc.orgId, doc.permittedPrincipals ?? [], doc.shareWithOrg)
    const principals = [...new Set([...(doc.permittedPrincipals ?? []), actingUserId])] // owner can always read
    return ingestor.ingest({ ...doc, ownerId: actingUserId, permittedPrincipals: principals })
  }

  // Authorized delete: only the owner or an admin may remove a record (+ its
  // edges, chunks, and ANN rows).
  function deleteRecord(actingUserId: string, recordId: string): void {
    authorizer.assertCanModify(actingUserId, recordId)
    const vids = store.db.query("SELECT json_extract(data,'$.virtualRecordId') v FROM nodes WHERE id = ?").all(recordId) as Array<{ v: string }>
    store.db.query("DELETE FROM nodes WHERE id = ?").run(recordId)
    store.db.query("DELETE FROM edges WHERE src = ? OR dst = ?").run(recordId, recordId)
    store.db.query("DELETE FROM chunks WHERE point_id LIKE ?").run(`${recordId}#%`)
    for (const { v } of vids) if (v) store.db.query("DELETE FROM chunks WHERE virtual_record_id = ?").run(v)
  }

  // HYBRID retrieval - three complementary signals fused with Reciprocal Rank Fusion
  // (the 2026 production default), then re-ranked. Signals:
  //   • DENSE  (vector + ACL) - semantic similarity (paraphrase, meaning).
  //   • SPARSE (BM25 / FTS5)  - exact tokens dense misses (acronyms "SAP", "£230M").
  //   • GRAPH  (GraphRAG)     - chunks reachable through related concepts.
  // RRF score = Σ 1/(k + rank) across the lists a chunk appears in (k=60), so a chunk
  // strong in ANY signal surfaces, and one strong in several rises to the top - with no
  // score-scale calibration between cosine and BM25. Then: personal boost (ownership),
  // memory decay/salience, cross-encoder rerank, passage extraction, diversity cap (MMR).
  // The pipeline lives in ./retrieval/* - this is a thin wrapper that threads the
  // shared embedded state into the orchestrator.
  async function searchWithGraph(query: string, userId: string, orgId: string, trace?: SearchTrace, limit?: number): Promise<RetrievalResponse> {
    return hybridSearch({ retrieval, store, graph, embeddings, reranker }, query, userId, orgId, trace, limit)
  }

  // LIVING MEMORY - the permission-aware atomic-memory layer (Supermemory parity, but
  // ACL-scoped). recallMemories returns the CURRENT truth (latest version, not forgotten)
  // about whatever the query is asking, ranked by semantic similarity, gated by the same
  // accessible-record set the rest of retrieval uses (leak-proof by construction).
  async function recallMemories(query: string, userId: string, orgId: string, limit = 8): Promise<RecalledMemory[]> {
    store.memories.sweep() // lazy TTL: retire any expired dynamic memories first
    const accessible = await graph.getAccessibleVirtualRecordIds({ userId, orgId })
    const vids = [...new Set(Object.values(accessible))]
    const rows = store.memories.recall(vids)
    if (rows.length === 0) return []
    const qv = await (embeddings.embedQuery ? embeddings.embedQuery(query) : embeddings.embedDense(query))
    const scored = rows.map((r) => ({ r, s: r.embedding ? cosine(qv, JSON.parse(r.embedding) as number[]) : 0 }))
    scored.sort((a, b) => b.s - a.s)
    return scored.slice(0, limit).map(({ r }) => ({
      memory: r.memory, version: r.version, isStatic: !!r.is_static, updatedAt: r.updated_at, rootId: r.root_id ?? r.id,
    }))
  }

  // Forget memories matching a description (semantic similarity OR substring), within
  // the caller's accessible set only - you can never forget what you can't see. Soft
  // delete (history kept, excluded from recall). Returns the memory texts forgotten.
  async function forgetMemories(query: string, userId: string, orgId: string, reason = "forgotten by user"): Promise<string[]> {
    const accessible = await graph.getAccessibleVirtualRecordIds({ userId, orgId })
    const vids = [...new Set(Object.values(accessible))]
    const rows = store.memories.recall(vids)
    if (rows.length === 0) return []
    const q = query.trim().toLowerCase()
    const qv = await (embeddings.embedQuery ? embeddings.embedQuery(query) : embeddings.embedDense(query))
    const targets = rows.filter((r) => {
      if (r.memory.toLowerCase().includes(q)) return true
      return r.embedding ? cosine(qv, JSON.parse(r.embedding) as number[]) >= 0.6 : false
    })
    if (targets.length === 0) return []
    store.memories.forget(targets.map((r) => r.id), reason)
    // Keep the forget COHERENT across layers: also expire the underlying typed edge so
    // KGQA / graph queries stop asserting the fact too. subject_key is `subj|pred` (a
    // single-valued fact) or `subj|pred|obj` (multi-valued) - both carry entity ids.
    for (const r of targets) {
      const parts = r.subject_key.split("|")
      if (parts.length === 2) store.expireEdges(parts[0], parts[1])
      else if (parts.length === 3) store.expireEdges(parts[0], parts[1], parts[2])
    }
    return targets.map((r) => r.memory)
  }

  // How a fact evolved: the full version chain (v1 → vN) for a memory's root. ACL is
  // enforced by the caller (recallMemories returns only accessible roots).
  function memoryHistory(rootId: string): Array<{ memory: string; version: number; isLatest: boolean; forgotten: boolean }> {
    return store.memories.history(rootId).map((r) => ({
      memory: r.memory, version: r.version, isLatest: !!r.is_latest, forgotten: !!r.is_forgotten,
    }))
  }

  // PROFILE synthesis - roll up everything currently known about one subject into a
  // compact, structured view: permanent facts (static), recent facts (dynamic, newest
  // first), and the entities it's most connected to. ACL-scoped (built only from the
  // caller's accessible memories + graph). Returns null when nothing is known. This is
  // the Supermemory "user profile" surface, generalized to any permitted entity.
  async function buildProfile(subject: string, userId: string, orgId: string): Promise<Profile | null> {
    store.memories.sweep()
    const accessible = await graph.getAccessibleVirtualRecordIds({ userId, orgId })
    const vids = [...new Set(Object.values(accessible))]
    const rows = store.memories.recall(vids)
    const eid = entityId(slugify(subject))
    const prefix = `${eid}|`
    const mine = rows.filter((r) => r.subject_key.startsWith(prefix))
    const nb = await graphQuery.neighbors(subject, userId, orgId)
    const related = (nb?.neighbors ?? []).slice(0, 10).map((n) => n.label)
    if (mine.length === 0 && related.length === 0) return null
    const staticFacts = mine.filter((r) => r.is_static).map((r) => r.memory)
    const recentFacts = mine
      .filter((r) => !r.is_static)
      .sort((a, b) => b.updated_at - a.updated_at)
      .map((r) => r.memory)
    return { subject: nb?.entity ?? subject, staticFacts, recentFacts, related }
  }

  // Same retrieval, but also returns the pipeline TRACE (for the UI's explainability).
  async function searchTraced(query: string, userId: string, orgId: string) {
    const trace: SearchTrace = { counts: { vector: 0, keyword: 0, graph: 0, fused: 0 }, reranked: false, items: [] }
    const response = await searchWithGraph(query, userId, orgId, trace)
    return { response, trace }
  }

  // Re-embed every stored chunk with the current embedder and rebuild the ANN
  // index. Needed when switching embedders (e.g. hash → transformers, different dim).
  async function reindex(): Promise<number> {
    store.resetVec()
    store.resetFts()
    const rows = store.db.query("SELECT point_id, virtual_record_id, org_id, content FROM chunks").all() as Array<{
      point_id: string
      virtual_record_id: string
      org_id: string
      content: string
    }>
    for (const r of rows) {
      const emb = await embeddings.embedDense(r.content)
      store.addChunk(r.point_id, r.virtual_record_id, r.org_id, r.content, emb)
    }
    // Memories carry their own embeddings (for semantic recall) - re-embed them too so
    // an embedder switch doesn't leave the memory layer in a stale vector space.
    for (const m of store.memories.all()) {
      store.memories.updateEmbedding(m.id, await embeddings.embedDense(m.memory))
    }
    return rows.length
  }

  // Re-extract the knowledge graph for EVERY existing record (e.g. after switching
  // to an LLM extractor, or for data ingested before extraction existed). Clears
  // the concept layer (entities + mentions + relates_to), keeps records/ACL/vectors.
  async function rebuildGraph(): Promise<{ records: number; entities: number }> {
    store.db.exec("DELETE FROM nodes WHERE coll = 'entities'")
    store.db.exec("DELETE FROM edges WHERE label IN ('mentions','relates_to')")
    const records = store.db.query("SELECT id, data FROM nodes WHERE coll = 'records'").all() as Array<{ id: string; data: string }>
    let entities = 0
    for (const rec of records) {
      const chunks = store.db
        .query("SELECT content FROM chunks WHERE point_id LIKE ? ORDER BY rowid")
        .all(`${rec.id}#%`) as Array<{ content: string }>
      const text = chunks.map((c) => c.content).join("\n\n")
      const name = (JSON.parse(rec.data) as { recordName?: string }).recordName
      if (text) entities += await ingestor.writeGraphFor(rec.id, text, name)
    }
    return { records: records.length, entities }
  }

  return {
    store,
    graph,
    vector,
    embeddings,
    retrieval,
    ingestor,
    authorizer,
    kgqa,
    graphQuery,
    ask,
    reconcile,
    authorizedIngest,
    deleteRecord,
    searchWithGraph,
    searchTraced,
    recallMemories,
    forgetMemories,
    memoryHistory,
    buildProfile,
    reindex,
    rebuildGraph,
  }
}

export type EmbeddedContext = ReturnType<typeof buildEmbeddedContext>
