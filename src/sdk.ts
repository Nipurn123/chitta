// The Chitta SDK — an ergonomic, typed facade over the embedded memory engine.
//
// Zero servers, zero config: `new Chitta()` gives you a permission-aware, zero-token
// knowledge-graph + vector memory that runs entirely in-process (Bun + SQLite). The single-user
// methods (remember / recall / …) act as a default admin user; use `.user(id)` for multi-tenant,
// per-user ACL. The full low-level engine is always reachable via `.ctx` as an escape hatch.

import { buildEmbeddedContext, type EmbeddedContext } from "./embedded/index"
import { LocalHashEmbeddings } from "./embedded/local-embeddings"
import { AutoEmbeddings, TransformersEmbeddings } from "./embedded/transformers-embeddings"
import { CrossEncoderReranker } from "./embedded/reranker"
import type { Role } from "./embedded/authorizer"
import type { EmbeddingProvider } from "./provider"

export interface ChittaOptions {
  /** SQLite file path. ":memory:" (default) is ephemeral; a real path persists across runs. */
  path?: string
  /** Embedder: "auto" (real semantic w/ hash fallback — default), "hash" (offline, deterministic,
   *  fast), "transformers" (force the real model), or your own EmbeddingProvider. */
  embeddings?: "auto" | "hash" | "transformers" | EmbeddingProvider
  /** Override the transformers model (e.g. a multilingual one). See CONTEXT_EMBED_PROFILE too. */
  embedModel?: string
  /** Cross-encoder reranker (default true; downloads a small model on first use, degrades to RRF
   *  order if unavailable). Turn off for the fastest / fully-offline path. */
  rerank?: boolean
  /** Default organization id for the single-user API (multi-tenant uses `.user(id, {org})`). */
  org?: string
}

export interface Entity {
  name: string
  type?: string
}
export interface Relation {
  from: string
  to: string
  /** SHORT snake_case predicate: works_at, lives_in, acquired, reports_to, … */
  type: string
}

export interface RememberOptions {
  /** Precise typed graph you already extracted — the zero-token path (no model re-reads the text). */
  entities?: Entity[]
  relations?: Relation[]
  /** Stable id for this memory (auto-generated if omitted). Pass the SAME id later to UPDATE it. */
  id?: string
  /** Human label for the source record. */
  name?: string
  /** Principals (besides the author) who may read this memory. */
  shareWith?: string[]
  /** Make it visible org-wide. */
  shareWithOrg?: boolean
  /** Time-anchored experiences → episodic memory. */
  episodes?: Array<{ event: string; occurredAt?: number | string; actors?: string[] }>
  /** Learned how-tos / preferences → procedural memory (trigger → action, supersedes on change). */
  procedures?: Array<{ trigger?: string; action: string }>
}

export interface Recalled {
  text: string
  score: number
  recordId?: string
  recordName?: string
}

const newId = (): string => `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

function pickEmbeddings(o: ChittaOptions): EmbeddingProvider {
  const e = o.embeddings ?? "auto"
  if (typeof e !== "string") return e
  if (e === "hash") return new LocalHashEmbeddings()
  if (e === "transformers") return new TransformersEmbeddings(o.embedModel)
  return new AutoEmbeddings(o.embedModel)
}

/** A user-scoped view of a Chitta store: every call is ACL-filtered to what THIS user may see
 *  (the permission moat). Obtain one via `chitta.user(id)`. */
export class ChittaUser {
  constructor(
    /** Escape hatch to the full low-level engine. */
    readonly ctx: EmbeddedContext,
    readonly userId: string,
    readonly orgId: string,
  ) {}

  /** Store something durable. Returns its record id — pass that back as `id` to UPDATE it later
   *  (functional facts self-correct: "works at Google" → "works at Meta" supersedes). */
  async remember(text: string, opts: RememberOptions = {}): Promise<{ id: string }> {
    const id = opts.id ?? newId()
    await this.ctx.authorizedIngest(this.userId, {
      recordId: id,
      orgId: this.orgId,
      recordName: opts.name ?? id,
      text,
      permittedPrincipals: [this.userId, ...(opts.shareWith ?? [])],
      shareWithOrg: opts.shareWithOrg ? this.orgId : undefined, // true ⇒ share org-wide (own org)
      entities: opts.entities,
      relations: opts.relations,
      episodes: opts.episodes,
      procedures: opts.procedures,
    })
    return { id }
  }

  /** Retrieve ranked, cited snippets relevant to a query — hybrid (vector + keyword + graph),
   *  reranked, and ACL-filtered to this user. */
  async recall(query: string, opts: { limit?: number } = {}): Promise<Recalled[]> {
    const res = await this.ctx.searchWithGraph(query, this.userId, this.orgId, undefined, opts.limit)
    return res.searchResults.map((r) => {
      const m = r.metadata as { recordId?: string; recordName?: string }
      return { text: r.content, score: r.score, recordId: m.recordId, recordName: m.recordName }
    })
  }

  /** The current atomic FACTS relevant to a query (self-correcting: superseded / contradicted
   *  facts are excluded — you get the current truth). */
  facts(query: string, opts: { limit?: number } = {}) {
    return this.ctx.recallMemories(query, this.userId, this.orgId, opts.limit)
  }

  /** Everything relevant: current facts + episodic events + procedural how-tos. */
  recallAll(query: string) {
    return this.ctx.recall(query, this.userId, this.orgId)
  }

  /** Forget memories matching a query. Non-destructive — history is kept; current recall excludes them. */
  forget(query: string, reason = "forgotten via SDK"): Promise<string[]> {
    return this.ctx.forgetMemories(query, this.userId, this.orgId, reason)
  }

  /** A structured profile of an entity: static facts + recent facts + graph neighborhood. */
  profile(subject: string) {
    return this.ctx.buildProfile(subject, this.userId, this.orgId)
  }

  /** The chronological event timeline for a subject (bi-temporal). */
  timeline(subject: string) {
    return this.ctx.timeline(subject, this.userId, this.orgId)
  }

  /** What was believed true AT a point in time (bi-temporal "as of"). */
  asOf(time: number | Date, subject?: string) {
    return this.ctx.asOf(time instanceof Date ? time.getTime() : time, this.userId, this.orgId, subject)
  }

  /** Graph queries, ACL-scoped to this user. */
  get graph() {
    const { ctx, userId, orgId } = this
    return {
      /** Typed neighbors of an entity (optionally by relation). */
      neighbors: (name: string, relation?: string) => ctx.graphQuery.neighbors(name, userId, orgId, relation),
      /** Entity-centric recall for a free-text query ("everything about Alice"). */
      related: (query: string, limit?: number) => ctx.graphQuery.neighborsForQuery(query, userId, orgId, limit),
      /** How are two entities connected? (shortest relation chain). */
      pathBetween: (a: string, b: string) => ctx.graphQuery.pathBetween(a, b, userId, orgId),
      /** The most-connected concepts in what this user knows. */
      central: (limit?: number) => ctx.graphQuery.central(userId, orgId, limit),
      /** Cohesive clusters of related entities. */
      communities: () => ctx.graphQuery.communities(userId, orgId),
    }
  }
}

/** Chitta — permission-aware, zero-token knowledge-graph + vector memory for AI agents. Runs
 *  in-process (Bun + SQLite), no servers. */
export class Chitta {
  /** The full low-level engine (escape hatch for advanced use). */
  readonly ctx: EmbeddedContext
  private readonly org: string
  private readonly provisioned = new Set<string>()
  private meCache?: ChittaUser

  constructor(opts: ChittaOptions = {}) {
    this.org = opts.org ?? "default-org"
    this.ctx = buildEmbeddedContext({
      path: opts.path ?? ":memory:",
      embeddings: pickEmbeddings(opts),
      reranker: opts.rerank === false ? undefined : new CrossEncoderReranker(),
    })
  }

  /** A user-scoped client for multi-tenant / per-user ACL. Idempotently provisions the user
   *  (role defaults to "editor"; groups drive shared access). */
  user(userId: string, opts: { role?: Role; org?: string; groups?: string[] } = {}): ChittaUser {
    const orgId = opts.org ?? this.org
    const key = `${userId} ${orgId}`
    if (!this.provisioned.has(key)) {
      this.ctx.ingestor.registerUser(userId, orgId, undefined, opts.role ?? "editor")
      for (const g of opts.groups ?? []) {
        this.ctx.ingestor.registerGroup(g)
        this.ctx.ingestor.addMembership(userId, g)
      }
      this.provisioned.add(key)
    }
    return new ChittaUser(this.ctx, userId, orgId)
  }

  // ── single-user convenience: a default admin "me" ──
  private me(): ChittaUser {
    return (this.meCache ??= this.user("me", { role: "admin" }))
  }
  /** Store something durable (single-user). */
  remember(text: string, opts?: RememberOptions) {
    return this.me().remember(text, opts)
  }
  /** Retrieve ranked, cited snippets (single-user). */
  recall(query: string, opts?: { limit?: number }) {
    return this.me().recall(query, opts)
  }
  /** Current atomic facts for a query (single-user). */
  facts(query: string, opts?: { limit?: number }) {
    return this.me().facts(query, opts)
  }
  /** Forget matching memories (single-user, non-destructive). */
  forget(query: string, reason?: string) {
    return this.me().forget(query, reason)
  }
  /** Structured profile of an entity (single-user). */
  profile(subject: string) {
    return this.me().profile(subject)
  }
  /** Event timeline for a subject (single-user). */
  timeline(subject: string) {
    return this.me().timeline(subject)
  }
  /** Graph queries (single-user). */
  get graph() {
    return this.me().graph
  }

  /** Store stats + engine info. */
  about() {
    const c = (sql: string) => (this.ctx.store.db.query(sql).get() as { c: number }).c
    return {
      records: c("SELECT count(*) c FROM nodes WHERE coll='records'"),
      entities: c("SELECT count(*) c FROM nodes WHERE coll='entities'"),
      chunks: c("SELECT count(*) c FROM chunks"),
      annEnabled: this.ctx.store.annEnabled,
    }
  }

  /** Close the underlying database. */
  close(): void {
    this.ctx.store.close()
  }
}
