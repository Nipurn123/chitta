// Embedded context stack: one SQLite file, in-process embeddings, zero servers.
// Wires the same RetrievalService (the moat) over embedded adapters - this is the
// single-binary path. `bun build --compile` over a CLI that calls this yields one
// self-contained executable.

import { RetrievalService } from "../retrieval"
import { SqliteStore } from "./sqlite-store"
import { SqliteGraphProvider } from "./sqlite-graph-provider"
import { SqliteVecService } from "./sqlite-vec-service"
import { LocalHashEmbeddings } from "./local-embeddings"
import { TransformersEmbeddings, AutoEmbeddings, resolveEmbedModel } from "./transformers-embeddings"
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
import { consolidateTriples } from "./memory/consolidate"
import type { ScopeSet } from "./store/memories"
import { nameMatch, typeBucket, type EntityCandidate } from "./graph/entity-resolution"
import { cosine } from "./retrieval/passage"
import { decodeF32 } from "./store/vector-blob"
import type { SearchTrace } from "./retrieval/trace"

/** A current memory surfaced to a caller (latest version, not forgotten), ACL-scoped. */
export interface RecalledMemory {
  memory: string
  version: number
  isStatic: boolean
  updatedAt: number
  rootId: string
}

/** A recalled EPISODIC memory - a time-anchored experience, ranked by relevance × recency. */
export interface RecalledEpisode {
  event: string
  occurredAt: number
  actorIds: string[]
}

/** A recalled PROCEDURAL memory - a learned how-to / preference (trigger → action). */
export interface RecalledProcedure {
  procedure: string
  version: number
}

/** One point on a subject's timeline - a fact change or an experience, with when it happened. */
export interface TimelineEvent {
  at: number
  kind: "fact" | "episode"
  text: string
  version: number
  /** True for a fact version that was later superseded or forgotten (no longer current). */
  superseded: boolean
}

/** A synthesized higher-order INSIGHT - reflection over the caller's accessible memory. */
export interface Insight {
  category: "focus" | "change" | "preference" | "recent"
  text: string
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
// bunfig preload, so tests never download a model). Model selection: CONTEXT_EMBED_MODEL (a repo
// id) wins, else CONTEXT_EMBED_PROFILE (fast|english-large|multilingual|on-device), else default.
// NOTE: a given DB is tied to ONE embedder's vector space - don't switch embedders on an
// existing DB (dims differ); reindex if you change modes.
export function defaultEmbeddings(): EmbeddingProvider {
  const mode = (process.env.CONTEXT_EMBEDDINGS ?? "auto").toLowerCase()
  const model = resolveEmbedModel()
  if (mode === "hash" || mode === "local") return new LocalHashEmbeddings()
  if (mode === "real" || mode === "transformers") return new TransformersEmbeddings(model)
  return new AutoEmbeddings(model)
}

// Choose which of two duplicate entities stays canonical: the better-connected node (more
// edges = more of the graph already points at it, so re-pointing the other is cheaper and
// preserves more structure), breaking ties by the lexicographically smaller id so the
// choice is deterministic. Returns [winnerId, loserId].
function pickWinner(a: EntityCandidate, c: EntityCandidate, degree: Map<string, number>): [string, string] {
  const da = degree.get(a.id) ?? 0
  const dc = degree.get(c.id) ?? 0
  if (da !== dc) return da > dc ? [a.id, c.id] : [c.id, a.id]
  return a.id < c.id ? [a.id, c.id] : [c.id, a.id]
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
  // hashing), the dims won't match - which would crash the ANN insert and corrupt cosine.
  // We detect the change once and reindex the whole DB to the CURRENT embedder. Runs at
  // most once per process; never blocks (failures are swallowed, ingest/query proceed).
  let reconcilePromise: Promise<void> | null = null
  function reconcile(): Promise<void> {
    return (reconcilePromise ??= (async () => {
      try {
        const row = store.db
          .query("SELECT embedding FROM chunks WHERE embedding IS NOT NULL LIMIT 1")
          .get() as { embedding: Uint8Array | string } | undefined
        if (!row) return // empty DB → the current embedder defines the vector space
        const storedDim = decodeF32(row.embedding).length
        const curDim = (await embeddings.embedDense("dimension probe")).length
        if (storedDim !== curDim) {
          // NEVER silent: this is the "my recall got weird" trap. No logger ⇒ stderr.
          const warn = opts.log?.error ?? ((m: string) => console.error(m))
          warn(`[chitta] embedder changed for this DB (${storedDim}d → ${curDim}d); reindexing all chunks to the current embedder`)
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
    // Belief-revision ACL scope: the records this writer can currently SEE, plus the one
    // being created. Consolidation supersedes/contradicts only within this set, so a user's
    // ingest can't clobber another user's PRIVATE memory (different visibility), while a
    // shared/org-wide fact still updates once for everyone who can see it, and two
    // contradicting facts inside THIS record still resolve.
    // Belief-revision scope, computed CHANGE-PROPORTIONALLY: rather than materialize the writer's
    // whole accessible set (O(N) per ingest → O(N²) for a bulk import), lazily ACL-check only the
    // few records a subject's live memories are actually anchored to, memoized per write. The
    // record being created is always visible to its writer (short-circuit) - which also covers
    // intra-record supersession before the new node is queryable.
    const selfVid = doc.virtualRecordId ?? doc.recordId
    const seen = new Map<string, boolean>()
    const scope: ScopeSet = {
      has: (vid: string): boolean => {
        if (vid === selfVid) return true
        let ok = seen.get(vid)
        if (ok === undefined) {
          ok = graph.canAccess(actingUserId, doc.orgId, vid)
          seen.set(vid, ok)
        }
        return ok
      },
      size: 1, // non-zero: the writer can always see the record they're creating
    }
    return ingestor.ingest({ ...doc, ownerId: actingUserId, permittedPrincipals: principals, scope })
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
    store.bumpVersion() // raw node/edge deletes bypass the facade → invalidate the ACL/graph cache
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
    await reconcile() // a store built by a DIFFERENT embedder must heal on read too, not only on ingest
    return hybridSearch({ retrieval, store, graph, embeddings, reranker }, query, userId, orgId, trace, limit)
  }

  // LIVING MEMORY - the permission-aware atomic-memory layer (Supermemory parity, but
  // ACL-scoped). recallMemories returns the CURRENT truth (latest version, not forgotten)
  // about whatever the query is asking, ranked by semantic similarity, gated by the same
  // accessible-record set the rest of retrieval uses (leak-proof by construction).
  // Self-heal: if the memory table is empty but the typed graph already has facts (data
  // ingested before the memory layer, or via the LLM extractor), backfill memories once -
  // so context_profile / the get_context memory section work on existing DBs with no manual
  // rebuild. Memoized; runs at most once per process and never blocks on failure.
  let ensureMemoriesPromise: Promise<void> | null = null
  function ensureMemories(): Promise<void> {
    return (ensureMemoriesPromise ??= (async () => {
      try {
        if (store.memories.counts().total > 0) return
        const hasTyped = store.db
          .query(
            `SELECT 1 FROM edges WHERE label NOT IN ('mentions','permissions','belongsTo','inheritPermissions','relates_to')
             AND expired_at IS NULL LIMIT 1`,
          )
          .get()
        if (hasTyped) await rebuildMemories()
      } catch {
        /* never block recall/profile on backfill */
      }
    })())
  }

  async function recallMemories(query: string, userId: string, orgId: string, limit = 8): Promise<RecalledMemory[]> {
    await reconcile() // memory embeddings live in the same vector space - heal drift on read
    await ensureMemories() // backfill from the graph on first use for pre-existing DBs
    store.memories.sweep() // lazy TTL: retire any expired dynamic memories first
    const accessible = await graph.getAccessibleVirtualRecordIds({ userId, orgId })
    const vids = [...new Set(Object.values(accessible))]
    const rows = store.memories.recall(vids)
    if (rows.length === 0) return []
    const qv = await (embeddings.embedQuery ? embeddings.embedQuery(query) : embeddings.embedDense(query))
    const scored = rows.map((r) => ({ r, s: r.embedding ? cosine(qv, decodeF32(r.embedding) as unknown as number[]) : 0 }))
    scored.sort((a, b) => b.s - a.s)
    // usage reinforcement: what gets recalled gets stronger (recency x frequency x importance)
    store.memories.reinforce(scored.slice(0, limit).map(({ r }) => r.id))
    return scored.slice(0, limit).map(({ r }) => ({
      memory: r.memory, version: r.version, isStatic: !!r.is_static, updatedAt: r.updated_at, rootId: r.root_id ?? r.id,
    }))
  }

  const embedQ = (q: string) => (embeddings.embedQuery ? embeddings.embedQuery(q) : embeddings.embedDense(q))

  // EPISODIC recall - time-anchored experiences ranked by relevance × recency (a recent
  // experience outweighs an old one of equal semantic match; ACT-R "recency"). ACL-scoped.
  async function recallEpisodes(query: string, userId: string, orgId: string, limit = 5): Promise<RecalledEpisode[]> {
    store.memories.sweep()
    const accessible = await graph.getAccessibleVirtualRecordIds({ userId, orgId })
    const rows = store.memories.recallEpisodes([...new Set(Object.values(accessible))])
    if (rows.length === 0) return []
    const qv = await embedQ(query)
    const now = Date.now()
    const halfLife = Number(process.env.CONTEXT_EPISODE_HALFLIFE_DAYS ?? 30) * 864e5
    const floor = Number(process.env.CONTEXT_EPISODE_FLOOR ?? 0.15) // require some semantic
    const scored = rows                                             // relevance so a recent but
      .map((r) => {                                                 // unrelated event isn't surfaced
        const rel = r.embedding ? cosine(qv, decodeF32(r.embedding) as unknown as number[]) : 0
        const recency = Math.pow(0.5, Math.max(0, now - (r.occurred_at ?? r.created_at)) / halfLife)
        return { r, rel, s: 0.7 * rel + 0.3 * recency }
      })
      .filter((x) => x.rel >= floor)
    scored.sort((a, b) => b.s - a.s)
    store.memories.reinforce(scored.slice(0, limit).map(({ r }) => r.id)) // recalled ⇒ reinforced
    return scored.slice(0, limit).map(({ r }) => ({
      event: r.memory,
      occurredAt: r.occurred_at ?? r.created_at,
      actorIds: JSON.parse(r.actor_ids) as string[],
    }))
  }

  // PROCEDURAL recall - the learned how-tos / preferences most applicable to the query,
  // ranked by semantic similarity (current versions only). ACL-scoped.
  async function recallProcedures(query: string, userId: string, orgId: string, limit = 3): Promise<RecalledProcedure[]> {
    store.memories.sweep()
    const accessible = await graph.getAccessibleVirtualRecordIds({ userId, orgId })
    const rows = store.memories.recallProcedures([...new Set(Object.values(accessible))])
    if (rows.length === 0) return []
    const qv = await embedQ(query)
    const floor = Number(process.env.CONTEXT_PROCEDURE_FLOOR ?? 0.15)
    const scored = rows
      .map((r) => ({ r, s: r.embedding ? cosine(qv, decodeF32(r.embedding) as unknown as number[]) : 0 }))
      .filter((x) => x.s >= floor)
    scored.sort((a, b) => b.s - a.s)
    store.memories.reinforce(scored.slice(0, limit).map(({ r }) => r.id)) // recalled ⇒ reinforced
    return scored.slice(0, limit).map(({ r }) => ({ procedure: r.memory, version: r.version }))
  }

  // UNIFIED recall across the memory typology - the current facts (semantic), the relevant
  // recent experiences (episodic), and the applicable how-tos (procedural). This is the
  // shape get_context surfaces so the caller sees the full memory, not just facts.
  async function recall(query: string, userId: string, orgId: string) {
    const [facts, episodes, procedures] = await Promise.all([
      recallMemories(query, userId, orgId),
      recallEpisodes(query, userId, orgId),
      recallProcedures(query, userId, orgId),
    ])
    return { facts, episodes, procedures }
  }

  // Forget memories matching a description (semantic similarity OR substring), within
  // the caller's accessible set only - you can never forget what you can't see. Soft
  // delete (history kept, excluded from recall). Returns the memory texts forgotten.
  async function forgetMemories(query: string, userId: string, orgId: string, reason = "forgotten by user"): Promise<string[]> {
    await ensureMemories()
    const accessible = await graph.getAccessibleVirtualRecordIds({ userId, orgId })
    const vids = [...new Set(Object.values(accessible))]
    const rows = store.memories.recall(vids)
    if (rows.length === 0) return []
    const q = query.trim().toLowerCase()
    const qv = await (embeddings.embedQuery ? embeddings.embedQuery(query) : embeddings.embedDense(query))
    const targets = rows.filter((r) => {
      if (r.memory.toLowerCase().includes(q)) return true
      return r.embedding ? cosine(qv, decodeF32(r.embedding) as unknown as number[]) >= 0.6 : false
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
    await ensureMemories()
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

  // TIMELINE - how a subject evolved: every fact version (with WHEN it became true)
  // interleaved with the experiences (episodes) involving it, chronologically. This is the
  // query surface for the bi-temporal store we already keep - "how did X change over time".
  // ACL-scoped (built only from the caller's accessible memories).
  async function timeline(subject: string, userId: string, orgId: string): Promise<{ subject: string; events: TimelineEvent[] }> {
    const accessible = await graph.getAccessibleVirtualRecordIds({ userId, orgId })
    const vids = [...new Set(Object.values(accessible))]
    const eid = store.resolveEntity(subject)?.id ?? entityId(slugify(subject))
    const node = store.db.query("SELECT data FROM nodes WHERE id = ?").get(eid) as { data: string } | undefined
    const label = node ? ((JSON.parse(node.data) as { label?: string }).label ?? subject) : subject
    const facts = store.memories.subjectHistory(eid, vids)
    const episodes = store.memories.episodesForActor(eid, vids)
    const events: TimelineEvent[] = [
      ...facts.map((f) => ({ at: f.created_at, kind: "fact" as const, text: f.memory, version: f.version, superseded: !f.is_latest || !!f.is_forgotten })),
      ...episodes.map((e) => ({ at: e.occurred_at ?? e.created_at, kind: "episode" as const, text: e.memory, version: 1, superseded: false })),
    ].sort((a, b) => a.at - b.at)
    return { subject: label, events }
  }

  // AS-OF - memory time-travel: the facts as they were BELIEVED at a past transaction time
  // t (optionally about one subject). Reconstructs the store's prior state from the version
  // chains - "what did we know about X on <date>". ACL-scoped.
  async function asOf(t: number, userId: string, orgId: string, subject?: string): Promise<string[]> {
    const accessible = await graph.getAccessibleVirtualRecordIds({ userId, orgId })
    const vids = [...new Set(Object.values(accessible))]
    let rows = store.memories.factsAsOf(vids, t)
    if (subject) {
      const eid = store.resolveEntity(subject)?.id ?? entityId(slugify(subject))
      rows = rows.filter((r) => r.subject_key.startsWith(`${eid}|`))
    }
    return rows.map((r) => r.memory)
  }

  // REFLECTION - synthesize higher-order INSIGHTS from what the caller can see: the recurring
  // focus (most-connected entities), facts that CHANGED (version chains), known preferences
  // (procedural memory), and recent activity (episodes). Computed on-demand per user over the
  // accessible set, so it is ACL-correct BY CONSTRUCTION - never persisted (a stored insight
  // could span records with different permissions and leak). Deterministic; no LLM.
  async function reflect(userId: string, orgId: string, limit = 8): Promise<Insight[]> {
    const accessible = await graph.getAccessibleVirtualRecordIds({ userId, orgId })
    const vals = [...new Set(Object.values(accessible))]
    const insights: Insight[] = []

    // Recurring focus: the entities the accessible graph is most built around (by degree).
    const g = graph.getKnowledgeGraph(vals)
    const degree = new Map<string, number>()
    for (const r of g.relations) {
      degree.set(r.from, (degree.get(r.from) ?? 0) + 1)
      degree.set(r.to, (degree.get(r.to) ?? 0) + 1)
    }
    const labelOf = new Map(g.entities.map((e) => [e.id, e.label] as const))
    const topFocus = [...degree.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).filter(([, d]) => d >= 2)
    for (const [id, d] of topFocus) insights.push({ category: "focus", text: `Recurring focus: ${labelOf.get(id) ?? id} (${d} connections)` })

    // Facts that CHANGED over time: single-valued facts now on version ≥ 2 (Meta ← Google).
    const changed = store.db
      .query(
        `SELECT root_id FROM memories WHERE kind = 'semantic' AND is_latest = 1 AND is_forgotten = 0
           AND version > 1 AND virtual_record_id IN (${vals.map(() => "?").join(",")}) LIMIT 5`,
      )
      .all(...vals) as Array<{ root_id: string }>
    for (const c of changed) {
      const hist = store.memories.history(c.root_id)
      if (hist.length >= 2) insights.push({ category: "change", text: `Changed over time: "${hist[0].memory}" → "${hist[hist.length - 1].memory}"` })
    }

    // Known preferences / how-tos (procedural memory).
    for (const p of store.memories.recallProcedures(vals).slice(0, 3)) insights.push({ category: "preference", text: `Known preference: ${p.memory}` })

    // Recent activity (episodic memory), newest first.
    for (const e of store.memories.recallEpisodes(vals).slice(0, 3)) insights.push({ category: "recent", text: `Recently: ${e.memory}` })

    return insights.slice(0, limit)
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

  // Backfill / rebuild the MEMORY layer from the typed graph that already exists. Atomic
  // memories are normally consolidated at ingest from the triples the caller supplies, so
  // data ingested BEFORE the memory layer (or via the LLM extractor) has graph edges but no
  // memories - which makes context_profile / the get_context memory section look empty. This
  // walks every LIVE typed edge (superseded ones are already excluded), resolves entity
  // labels + the asserting record's ACL anchor (org + virtual record), and consolidates each
  // into a current memory. Idempotent: clears the memory table first. Returns the count.
  async function rebuildMemories(): Promise<number> {
    store.db.exec("DELETE FROM memories")
    const labelOf = new Map(
      (store.db.query("SELECT id, data FROM nodes WHERE coll = 'entities'").all() as Array<{ id: string; data: string }>).map(
        (r) => [r.id, (JSON.parse(r.data) as { label?: string }).label ?? r.id] as const,
      ),
    )
    const recMeta = new Map(
      (store.db.query("SELECT id, data FROM nodes WHERE coll = 'records'").all() as Array<{ id: string; data: string }>).map((r) => {
        const d = JSON.parse(r.data) as { virtualRecordId?: string; orgId?: string }
        return [r.id, { vid: d.virtualRecordId ?? r.id, orgId: d.orgId ?? "" }] as const
      }),
    )
    const edges = store.db
      .query(
        `SELECT src, dst, label, provenance FROM edges
         WHERE label NOT IN ('mentions','permissions','belongsTo','inheritPermissions','relates_to')
           AND expired_at IS NULL`,
      )
      .all() as Array<{ src: string; dst: string; label: string; provenance: string }>
    let count = 0
    for (const e of edges) {
      const from = labelOf.get(e.src)
      const to = labelOf.get(e.dst)
      if (!from || !to) continue
      const prov = JSON.parse(e.provenance) as string[]
      const rec = prov.map((p) => recMeta.get(p)).find(Boolean)
      if (!rec) continue // no known asserting record → can't ACL-anchor it
      const tally = await consolidateTriples(store.memories, embeddings, [{ from, to, type: e.label }], {
        orgId: rec.orgId,
        virtualRecordId: rec.vid,
        sourceRecordId: prov[0],
        resolve: (name) => store.resolveEntity(name)?.id ?? null,
      })
      count += tally.created + tally.updated
    }
    return count
  }

  // Re-extract the knowledge graph for EVERY existing record (e.g. after switching
  // to an LLM extractor, or for data ingested before extraction existed). Clears
  // the concept layer (entities + mentions + relates_to), keeps records/ACL/vectors.
  async function rebuildGraph(): Promise<{ records: number; entities: number }> {
    store.db.exec("DELETE FROM nodes WHERE coll = 'entities'")
    store.db.exec("DELETE FROM edges WHERE label IN ('mentions','relates_to')")
    // Clear the alias map too: it is only valid while its canonical nodes exist, and we're
    // deleting them all. Re-extraction re-derives canonicalization from scratch (the
    // resolver re-merges surface variants as nodes are recreated record-by-record).
    store.db.exec("DELETE FROM entity_aliases")
    store.bumpVersion() // raw deletes bypass the facade → invalidate before re-extraction
    const records = store.db.query("SELECT id, data FROM nodes WHERE coll = 'records'").all() as Array<{ id: string; data: string }>
    let entities = 0
    for (const rec of records) {
      const chunks = store.db
        .query("SELECT content FROM chunks WHERE point_id LIKE ? ORDER BY rowid")
        .all(`${rec.id}#%`) as Array<{ content: string }>
      const text = chunks.map((c) => c.content).join("\n\n")
      const name = (JSON.parse(rec.data) as { recordName?: string }).recordName
      if (text) entities += (await ingestor.writeGraphFor(rec.id, text, name)).entities
    }
    return { records: records.length, entities }
  }

  // Retroactive entity DEDUPE - fold surface-form duplicate entities that predate the
  // resolver (data ingested before entity resolution existed, or via a path that created
  // separate nodes) into one canonical each. Only merges pairs the SAME high-precision
  // rules accept, so it never collapses genuinely distinct entities. The better-connected
  // (then lexicographically-smaller-id) node wins as canonical, keeping ids stable;
  // store.mergeEntities re-points edges + memory subject_keys non-destructively. Idempotent
  // (a second run finds nothing). Returns how many entities were merged away.
  function dedupeEntities(): number {
    const ents = store.entities.allEntities()
    const degree = new Map<string, number>()
    for (const e of ents) {
      const d = store.db.query("SELECT count(*) c FROM edges WHERE src = ? OR dst = ?").get(e.id, e.id) as { c: number }
      degree.set(e.id, d.c)
    }
    const alive = new Set(ents.map((e) => e.id))
    let merged = 0
    for (const e of ents) {
      if (!alive.has(e.id)) continue // already merged into another canonical
      for (const c of store.entities.candidates(e.label, typeBucket(e.type))) {
        if (c.id === e.id || !alive.has(c.id)) continue
        if (!nameMatch(e.label, e.type, c.label, c.type).match) continue
        const [winner, loser] = pickWinner(e, c, degree)
        store.mergeEntities(loser, winner)
        alive.delete(loser)
        degree.set(winner, (degree.get(winner) ?? 0) + (degree.get(loser) ?? 0))
        merged++
        if (loser === e.id) break // e itself was merged away → stop pairing it
      }
    }
    return merged
  }

  // SLEEP-TIME CONSOLIDATION - a background maintenance pass that makes the memory self-
  // improve offline (the 2025-26 "sleep-time compute" idea, done deterministically): fold
  // duplicate entities into their canonical (Stage 1), retire expired dynamic memories, and
  // re-weight record importance by CORROBORATION - a fact many records attest to matters more.
  // Idempotent (safe to run on a schedule), ACL-agnostic (structural maintenance, not a read).
  function sleep(): { entitiesMerged: number; memoriesExpired: number; recordsReweighted: number } {
    const entitiesMerged = dedupeEntities()
    const memoriesExpired = store.memories.sweep()
    const recordsReweighted = reweightByCorroboration()
    return { entitiesMerged, memoriesExpired, recordsReweighted }
  }

  // Re-weight each record's importance = its immutable write-time base + a bounded boost for
  // every entity it mentions that MULTIPLE records also mention (corroboration → salience).
  // Idempotent: the base never moves, the boost is a pure function of the current graph.
  // Deliberately does NOT bump the data-version (importance is salience data, not ACL/graph
  // topology - so it can't invalidate the memoized permission view or thrash the cache).
  function reweightByCorroboration(): number {
    const mentionCounts = new Map<string, number>()
    for (const r of store.db.query("SELECT dst, count(*) c FROM edges WHERE label = 'mentions' GROUP BY dst").all() as Array<{ dst: string; c: number }>)
      mentionCounts.set(r.dst, r.c)
    const records = store.db.query("SELECT id, data FROM nodes WHERE coll = 'records'").all() as Array<{ id: string; data: string }>
    const mentionsOf = store.db.query("SELECT dst FROM edges WHERE src = ? AND label = 'mentions'")
    let n = 0
    for (const rec of records) {
      const d = JSON.parse(rec.data) as { importance?: number; importanceBase?: number }
      const base = d.importanceBase ?? d.importance ?? 1
      const ments = mentionsOf.all(rec.id) as Array<{ dst: string }>
      const corroborated = ments.filter((m) => (mentionCounts.get(m.dst) ?? 0) >= 2).length
      const next = Math.max(0.5, Math.min(3, Number((base + Math.min(0.5, 0.05 * corroborated)).toFixed(3))))
      if (next !== d.importance || d.importanceBase === undefined) {
        store.db.query("UPDATE nodes SET data = json_set(json_set(data,'$.importance',?),'$.importanceBase',?) WHERE id = ?").run(next, base, rec.id)
        n++
      }
    }
    return n
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
    recallEpisodes,
    recallProcedures,
    recall,
    forgetMemories,
    memoryHistory,
    buildProfile,
    timeline,
    asOf,
    reflect,
    rebuildMemories,
    reindex,
    rebuildGraph,
    dedupeEntities,
    sleep,
  }
}

export type EmbeddedContext = ReturnType<typeof buildEmbeddedContext>
