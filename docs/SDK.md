# Chitta SDK

**Zero-token**, local knowledge-graph + vector memory for AI agents - permanent memory that persists across sessions, in-process, no servers to run. Chitta runs on **Bun** (it uses `bun:sqlite`), stores everything in a single SQLite file, and never spends an LLM token to remember or retrieve. It's permission-aware from the same engine, too, so the identical store scales from a single agent to a whole team once you need that - see "Multi-tenant / per-user ACL" and "Multi-agent memory" below.

```bash
bun add @100xprompt/chitta
```

## Quickstart (single user)

```ts
import { Chitta } from "@100xprompt/chitta"

const memory = new Chitta({ path: "./memory.db" }) // ":memory:" (default) is ephemeral

await memory.remember("The launch is scheduled for March 3rd.")
await memory.remember("Our primary datastore is PostgreSQL 16.")

const hits = await memory.recall("when do we launch?")
// → [{ text: "The launch is scheduled for March 3rd.", score, recordId, recordName }]

memory.close()
```

`recall` runs the full **hybrid** pipeline - vector + keyword (BM25) + graph, fused with RRF, cross-encoder reranked, ACL-filtered - and returns ranked, cited snippets. No LLM in the loop.

## Ask (one cited answer, fully local)

When you want **the answer** instead of ranked snippets, `ask` runs the same zero-token retrieval and hands the notes to a tiny LLM running **inside your process** (llama.cpp bindings - no Ollama, no server, no API key):

```ts
const r = await memory.ask("when do we launch?")
r.answer      // "The launch is scheduled for March 3rd [1]."
r.sources     // the numbered notes it cited: { n, kind: "graph"|"fact"|"snippet", text, name? }
r.synthesized // false ⇒ memory had nothing relevant and NO model was invoked
```

- The default model (Qwen2.5-0.5B instruct, ~0.4 GB) downloads once on first use, then **stays loaded** - repeat asks run in ~0.5 s. Stream with `onToken`, cap grounding with `limit`, swap models with `{ model: "<gguf path|url>" }`.
- Set `CONTEXT_LLM_URL` (plus `CONTEXT_LLM_MODEL` / `CONTEXT_LLM_KEY`) and `ask` uses any OpenAI-compatible endpoint instead - Ollama, LM Studio, vLLM, or a cloud model.
- The model is instructed to use **only** the retrieved notes and to say *"I don't have that in memory"* otherwise - and on an empty retrieval it is never called at all. Grounded by construction, belief-revised by inheritance (superseded facts never reach the prompt).

## Precise, zero-token knowledge graph

You (or your agent) already read the text - so pass the entities and relations you saw. Chitta stores them as **typed triples**: no second model re-reads anything, and the graph answers relational questions exactly.

```ts
await memory.remember("Sarah Chen works at Google as a staff engineer.", {
  entities: [{ name: "Sarah Chen", type: "PERSON" }, { name: "Google", type: "ORG" }],
  relations: [{ from: "Sarah Chen", to: "Google", type: "works_at" }], // SHORT snake_case predicate
})
```

**Self-correction is automatic.** A newer functional fact supersedes the old one - non-destructively (history is kept):

```ts
await memory.remember("Sarah now works at Meta.", {
  entities: [{ name: "Sarah Chen" }, { name: "Meta" }],
  relations: [{ from: "Sarah Chen", to: "Meta", type: "works_at" }],
})

await memory.facts("where does Sarah work")
// → current truth only: "Sarah Chen works_at Meta"  (Google is superseded, no LLM involved)
```

## Graph queries

```ts
await memory.graph.neighbors("Sarah Chen")          // typed neighbors
await memory.graph.related("everything about Meta")  // entity-centric free-text recall
await memory.graph.pathBetween("Sarah Chen", "Meta") // how are they connected?
await memory.graph.central()                          // most-connected concepts
```

## Multi-tenant / per-user ACL (the moat)

Everything above works for a single agent out of the box. When memory needs to scale to a team, the same store goes multi-tenant with no migration: every read is filtered to what the asking user may see - enforced **before** search, so a memory can never leak across a permission boundary.

```ts
const alice = memory.user("alice", { role: "editor" })
const bob   = memory.user("bob")

await alice.remember("Alice's private roadmap: ship v2 in Q3.")
await bob.remember("Bob's private budget is $50k.", { shareWith: ["alice"] }) // grant alice read

await bob.recall("roadmap")   // → [] - Bob cannot see Alice's private memory
await alice.recall("budget")  // → sees Bob's, because he shared it
```

`shareWithOrg: true` on `remember` makes a memory visible org-wide.

## Multi-agent memory (perspectives)

Agent teams need what human teams do: **one shared store, per-principal visibility**. Chitta gets this for free, because an agent is just a principal - `memory.agent(id)` gives every agent its own ACL-scoped view over the shared graph. This is not new machinery; it is the multi-tenant ACL above applied to agents. Agent ids are **namespaced** (`"planner"` → principal `agent:planner`), so an agent and a human with the same name never collide.

```ts
const planner = memory.agent("planner")
const critic  = memory.agent("critic")
memory.team("research", { agents: [planner, critic] }) // an agent group (principal "team:research")

await planner.remember("Draft: rollout targets March 3.")                // private to planner (default)
await critic.remember("Note for the planner.", { shareWith: [planner] })  // direct grant (agent or user)
await planner.remember("Corpus lives at s3://corpus-v2.", { shareWithTeam: "research" })  // the whole team

await critic.recall("rollout")  // → [] - planner's draft stays private
```

`shareWithTeam` respects the same no-over-sharing rule users get: a non-admin agent can only grant to a team it belongs to.

### Perspective queries

Each agent's graph view is provenance-filtered (a relation is visible only if a record that agent may access asserted it), so comparing perspectives is a set operation over typed triples:

```ts
await memory.perspectives.diff(planner, critic)
// → { aOnly: [{ from, type, to }, ...], bOnly: [...] }
//   aOnly = what planner can see that critic cannot; bOnly = the reverse

await memory.perspectives.shared([planner, critic])
// → the typed facts EVERY listed principal can see - the team's common ground
```

Both accept handles (`planner`) or raw principal ids (`"agent:planner"`, `"alice"`) - humans and agents mix freely in the same store and the same queries.

## Temporal (bi-temporal)

```ts
await memory.timeline("Sarah Chen")        // chronological events
await memory.user("alice").asOf(Date.now() - 30 * 864e5, "Sarah Chen") // what was true 30 days ago
```

## Options

```ts
new Chitta({
  path: "./memory.db",       // SQLite file (":memory:" = ephemeral, default)
  embeddings: "auto",         // "auto" (real semantic + hash fallback) | "hash" (offline, fast) | "transformers" | your own provider
  embedModel: undefined,      // override the transformers model (e.g. multilingual)
  rerank: true,               // cross-encoder reranker (downloads a small model on first use)
  org: "default-org",         // default org for the single-user API
})
```

### Scaling flags (env)

| Env | Effect |
|---|---|
| `CONTEXT_DISKANN=1` | Native **DiskANN** vector index (sub-linear dense) - for large, read-heavy corpora (opt-in; higher ingest cost). |
| `CONTEXT_DB_KEY=…` | At-rest **AES-256 encryption** (libSQL) + DiskANN. |
| `CONTEXT_EMBED_PROFILE=multilingual` | One-liner model upgrade (`fast` \| `english-large` \| `multilingual` \| `on-device`). |
| `CONTEXT_FILTER_FIRST_MAX=2000` | Threshold below which dense search scans exactly the accessible set (filtered-ANN, on by default). |

For scoped multi-tenant users, **filtered-ANN** already makes dense retrieval O(accessible) - no flag needed.

## Escape hatch

The full low-level engine is always available at `memory.ctx` - episodic/procedural recall, reflection, sleep-time consolidation, KGQA, entity dedupe, reindex, and more.

## API summary

| Method | Description |
|---|---|
| `remember(text, opts?)` | Store durable memory; returns `{ id }` (pass `id` back to update). |
| `recall(query, {limit?})` | Ranked, cited snippets (hybrid, reranked, ACL-filtered). |
| `ask(question, {model?, limit?, onToken?})` | ONE direct, cited answer via an in-process local LLM (or `CONTEXT_LLM_URL`). |
| `facts(query, {limit?})` | Current atomic facts (self-correcting). |
| `forget(query, reason?)` | Non-destructive forget (history kept). |
| `profile(subject)` | Static + recent facts + neighborhood for an entity. |
| `timeline(subject)` / `asOf(t, subject?)` | Bi-temporal views. |
| `graph.{neighbors, related, pathBetween, central, communities}` | Graph queries (ACL-scoped). |
| `user(id, {role?, org?, groups?})` | Per-user scoped client (multi-tenant ACL). |
| `agent(id, {role?, org?, teams?})` | Per-agent scoped client (principal `agent:<id>`); its `remember` adds `shareWithTeam`. |
| `team(id, {agents})` | Provision an agent group (principal `team:<id>`) with shared visibility. |
| `perspectives.diff(a, b)` / `.shared([...])` | Belief diff / intersection between principals' ACL-scoped views. |
| `about()` | Store stats + engine info. `close()` shuts the DB. |
