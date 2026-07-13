// The Chitta SDK - an ergonomic, typed facade over the embedded memory engine.
//
// Zero servers, zero config: `new Chitta()` gives you a permission-aware, zero-token
// knowledge-graph + vector memory that runs entirely in-process (Bun + SQLite). The single-user
// methods (remember / recall / …) act as a default admin user; use `.user(id)` for multi-tenant,
// per-user ACL and `.agent(id)` / `.team(id)` to give each AGENT of a team its own memory
// perspective over the shared graph (compare perspectives via `.perspectives`). The full
// low-level engine is always reachable via `.ctx` as an escape hatch.

import { buildEmbeddedContext, type EmbeddedContext } from "./embedded/index"
import { LocalHashEmbeddings } from "./embedded/local-embeddings"
import { AutoEmbeddings, TransformersEmbeddings } from "./embedded/transformers-embeddings"
import { CrossEncoderReranker } from "./embedded/reranker"
import type { Role } from "./embedded/authorizer"
import type { Belief, BeliefDiffResult } from "./embedded/graph-query"
import type { EmbeddingProvider } from "./provider"
import { ConfigError } from "./errors"

export type { Belief, BeliefDiffResult } from "./embedded/graph-query"

export interface ChittaOptions {
  /** SQLite file path. ":memory:" (default) is ephemeral; a real path persists across runs. */
  path?: string
  /** Embedder: "auto" (real semantic w/ hash fallback - default), "hash" (offline, deterministic,
   *  fast), "transformers" (force the real model), or your own EmbeddingProvider. */
  embeddings?: "auto" | "hash" | "transformers" | EmbeddingProvider
  /** Override the transformers model (e.g. a multilingual one). See CONTEXT_EMBED_PROFILE too. */
  embedModel?: string
  /** Cross-encoder reranker (default true; downloads a small model on first use, degrades to RRF
   *  order if unavailable). Turn off for the fastest / fully-offline path. */
  rerank?: boolean
  /** Default organization id for the single-user API (multi-tenant uses `.user(id, {org})`). */
  org?: string
  /** Observability hook, fired after `remember` / `recall` / `facts` with the op name, elapsed
   *  milliseconds, and (where meaningful) the result `count`. Wrapped in try/catch - a throwing
   *  handler never breaks the call. Zero overhead when unset. */
  onEvent?: (e: { op: string; ms: number; count?: number }) => void
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
  /** Precise typed graph you already extracted - the zero-token path (no model re-reads the text). */
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

// ── principal namespacing ──
// Agents and teams are ordinary ACL principals, but their ids live under a prefix so an
// agent named "alice" can never collide with (or read as) the human user "alice". The ACL
// machinery itself is namespace-blind - the prefix is purely an identity convention, applied
// idempotently (an already-prefixed id passes through).

/** The principal id an agent is registered under: "planner" → "agent:planner". */
export const agentPrincipal = (agentId: string): string => (agentId.startsWith("agent:") ? agentId : `agent:${agentId}`)
/** The principal id a team (agent group) is registered under: "research" → "team:research". */
export const teamPrincipal = (teamId: string): string => (teamId.startsWith("team:") ? teamId : `team:${teamId}`)

/** A principal reference: a raw principal id, or a scoped client (agent or user) whose
 *  `userId` is used - so `shareWith: [critic]` and `perspectives.diff(planner, critic)`
 *  read naturally without string-plumbing. */
export type PrincipalRef = string | ChittaUser
const principalId = (p: PrincipalRef): string => (typeof p === "string" ? p : p.userId)

/** The named embedder presets accepted as a string (anything else must be an EmbeddingProvider). */
const EMBED_MODES = ["auto", "hash", "transformers"] as const

/** Fail fast on a malformed `ChittaOptions` before we build the engine - with a message that
 *  tells the caller exactly what's valid. */
function validateOptions(o: ChittaOptions): void {
  const e = o.embeddings
  if (typeof e === "string" && !(EMBED_MODES as readonly string[]).includes(e)) {
    const modes = EMBED_MODES.map((m) => `"${m}"`).join(", ")
    throw new ConfigError(`invalid embeddings "${e}" - expected one of ${modes}, or an EmbeddingProvider instance`)
  }
  if (o.path !== undefined && (typeof o.path !== "string" || o.path.trim().length === 0)) {
    throw new ConfigError(`invalid path - expected a non-empty string (or omit for an in-memory store), got ${JSON.stringify(o.path)}`)
  }
}

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
    /** Observability hook, threaded from the parent `Chitta` (see `ChittaOptions.onEvent`). */
    private readonly onEvent?: ChittaOptions["onEvent"],
  ) {}

  /** Fire the observability hook. Guarded (unset ⇒ zero work) and wrapped so a throwing
   *  handler can never break the memory operation it observes. */
  private emit(op: string, startedAt: number, count?: number): void {
    if (!this.onEvent) return
    try {
      this.onEvent({ op, ms: performance.now() - startedAt, count })
    } catch {
      // a bad observer must never break a call - swallow it
    }
  }

  /** Store something durable. Returns its record id - pass that back as `id` to UPDATE it later
   *  (functional facts self-correct: "works at Google" → "works at Meta" supersedes). */
  async remember(text: string, opts: RememberOptions = {}): Promise<{ id: string }> {
    const t0 = this.onEvent ? performance.now() : 0
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
    this.emit("remember", t0)
    return { id }
  }

  /** Store many memories in one call - each item is a full `remember` (its own record + typed
   *  graph). Returns the ids in input order. */
  async rememberMany(items: Array<{ text: string } & RememberOptions>): Promise<{ id: string }[]> {
    const out: { id: string }[] = []
    for (const { text, ...opts } of items) {
      out.push(await this.remember(text, opts))
    }
    return out
  }

  /** Retrieve ranked, cited snippets relevant to a query - hybrid (vector + keyword + graph),
   *  reranked, and ACL-filtered to this user. */
  async recall(query: string, opts: { limit?: number } = {}): Promise<Recalled[]> {
    const t0 = this.onEvent ? performance.now() : 0
    const res = await this.ctx.searchWithGraph(query, this.userId, this.orgId, undefined, opts.limit)
    const out = res.searchResults.map((r) => {
      const m = r.metadata as { recordId?: string; recordName?: string }
      return { text: r.content, score: r.score, recordId: m.recordId, recordName: m.recordName }
    })
    this.emit("recall", t0, out.length)
    return out
  }

  /** The current atomic FACTS relevant to a query (self-correcting: superseded / contradicted
   *  facts are excluded - you get the current truth). */
  async facts(query: string, opts: { limit?: number } = {}) {
    const t0 = this.onEvent ? performance.now() : 0
    const res = await this.ctx.recallMemories(query, this.userId, this.orgId, opts.limit)
    this.emit("facts", t0, res.length)
    return res
  }

  /** Everything relevant: current facts + episodic events + procedural how-tos. */
  recallAll(query: string) {
    return this.ctx.recall(query, this.userId, this.orgId)
  }

  /** Forget memories matching a query. Non-destructive - history is kept; current recall excludes them. */
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

export interface AgentRememberOptions extends Omit<RememberOptions, "shareWith"> {
  /** Principals who may also read this memory - other agent/user handles, or raw
   *  principal ids ("alice", "agent:critic"). Omit for a private memory (the default). */
  shareWith?: PrincipalRef[]
  /** Share with a whole TEAM (agent group) - every member may read it. Plain team ids are
   *  accepted ("research" → "team:research"). Non-admin agents may only grant to a team
   *  they belong to (the same no-over-sharing rule human users get). */
  shareWithTeam?: string | string[]
}

/** An agent-scoped view of a Chitta store - `chitta.user()` for agents. An agent IS a
 *  principal (namespaced `agent:<id>`), so it inherits the whole ChittaUser surface with
 *  the same ACL moat: memories are private by default, shareable per-memory with specific
 *  agents/users (`shareWith`) or a whole agent team (`shareWithTeam`). Obtain one via
 *  `chitta.agent(id)`; compare agents' views via `chitta.perspectives`. */
export class ChittaAgent extends ChittaUser {
  /** Store a memory as this agent - private by default; `shareWith` grants specific
   *  principals, `shareWithTeam` grants an agent group. Same update semantics as
   *  ChittaUser.remember (pass the returned `id` back to supersede). */
  override remember(text: string, opts: AgentRememberOptions = {}): Promise<{ id: string }> {
    const { shareWith, shareWithTeam, ...rest } = opts
    const teams = (Array.isArray(shareWithTeam) ? shareWithTeam : shareWithTeam ? [shareWithTeam] : []).map(teamPrincipal)
    return super.remember(text, { ...rest, shareWith: [...(shareWith ?? []).map(principalId), ...teams] })
  }
}

/** Chitta - permission-aware, zero-token knowledge-graph + vector memory for AI agents. Runs
 *  in-process (Bun + SQLite), no servers. */
export class Chitta {
  /** The full low-level engine (escape hatch for advanced use). */
  readonly ctx: EmbeddedContext
  private readonly org: string
  private readonly onEvent?: ChittaOptions["onEvent"]
  private readonly provisioned = new Set<string>()
  private meCache?: ChittaUser

  constructor(opts: ChittaOptions = {}) {
    validateOptions(opts)
    this.org = opts.org ?? "default-org"
    this.onEvent = opts.onEvent
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
    return new ChittaUser(this.ctx, userId, orgId, this.onEvent)
  }

  /** An AGENT-scoped client over the SAME store - the multi-tenant ACL applied to agents,
   *  so every agent on a shared graph gets its own memory perspective. The id is namespaced
   *  ("planner" → principal "agent:planner"), so agents and human users never collide.
   *  Idempotently provisions the agent (role defaults to "editor"); `teams` also enrolls it
   *  in those agent groups (see `team()`). */
  agent(agentId: string, opts: { role?: Role; org?: string; teams?: string[] } = {}): ChittaAgent {
    const id = agentPrincipal(agentId)
    const orgId = opts.org ?? this.org
    const key = `${id} ${orgId}`
    if (!this.provisioned.has(key)) {
      this.ctx.ingestor.registerUser(id, orgId, undefined, opts.role ?? "editor")
      this.provisioned.add(key) // before team(): its agent() re-entry must short-circuit
      for (const t of opts.teams ?? []) this.team(t, { agents: [id] })
    }
    return new ChittaAgent(this.ctx, id, orgId, this.onEvent)
  }

  /** Provision a TEAM - a group of agents with shared visibility, registered under the
   *  principal "team:<id>". Members share memories to it per-memory (`shareWithTeam`) and
   *  every member can recall them. Accepts agent handles or plain agent ids (strings are
   *  provisioned as agents; pass a ChittaUser handle to enroll a human). Idempotent - call
   *  again with more agents to grow the team. */
  team(teamId: string, opts: { agents: PrincipalRef[] }): { id: string; agents: string[] } {
    const tid = teamPrincipal(teamId)
    this.ctx.ingestor.registerGroup(tid)
    const members = opts.agents.map((a) => (typeof a === "string" ? this.agent(a).userId : a.userId))
    for (const m of members) this.ctx.ingestor.addMembership(m, tid)
    return { id: tid, agents: members }
  }

  /** PERSPECTIVE queries - compare what different principals (agents or humans) can see
   *  over the shared graph. Honest mechanics: set operations over each principal's
   *  ACL-scoped typed relations, so the usual invariant applies per side - a relation
   *  counts as a belief only if a record THAT principal may access asserted it. Accepts
   *  handles (`planner`) or raw principal ids ("agent:planner", "alice"). */
  get perspectives(): {
    diff: (a: PrincipalRef, b: PrincipalRef) => Promise<BeliefDiffResult>
    shared: (principals: PrincipalRef[]) => Promise<Belief[]>
  } {
    const org = (p: PrincipalRef) => (typeof p === "string" ? this.org : p.orgId)
    return {
      // typed beliefs A can see that B cannot (aOnly), and vice versa (bOnly)
      diff: (a, b) => this.ctx.graphQuery.beliefDiff(principalId(a), principalId(b), org(a)),
      // typed beliefs EVERY listed principal can see - the team's common ground
      shared: (principals) =>
        this.ctx.graphQuery.sharedBeliefs(principals.map(principalId), principals.length ? org(principals[0]) : this.org),
    }
  }

  // ── single-user convenience: a default admin "me" ──
  private me(): ChittaUser {
    return (this.meCache ??= this.user("me", { role: "admin" }))
  }
  /** Store something durable (single-user). */
  remember(text: string, opts?: RememberOptions) {
    return this.me().remember(text, opts)
  }
  /** Store many memories at once (single-user). */
  rememberMany(items: Array<{ text: string } & RememberOptions>) {
    return this.me().rememberMany(items)
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

  /** Walk a directory and learn it permanently: code files are parsed into a code graph
   *  (tree-sitter, 36 languages), docs into the concept graph - all recallable forever after.
   *  Idempotent per file (stable record ids), zero LLM tokens. Returns honest stats. */
  async learn(dir: string, opts: { maxFiles?: number; maxFileBytes?: number } = {}) {
    const { learnDirectory } = await import("./embedded/learn")
    const u = this.me()
    return learnDirectory(this.ctx, u.userId, u.orgId, dir, opts)
  }

  /** Export the full accessible knowledge graph as ONE self-contained, interactive HTML page -
   *  Chitta's shareable "what your agent remembers" artifact. Returns the HTML string; write it to
   *  a `.html` file and open in any browser (force-directed, colored by type, search + zoom). */
  async graphHtml(opts: { title?: string } = {}): Promise<string> {
    const { renderGraphHtml } = await import("./embedded/graph-html")
    const u = this.me()
    const accessible = await this.ctx.graph.getAccessibleVirtualRecordIds({ userId: u.userId, orgId: u.orgId })
    const recordIds = [...new Set(Object.values(accessible))] as string[]
    return renderGraphHtml(this.ctx.graph.getKnowledgeGraph(recordIds), opts)
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
