# Architecture

Chitta is a **zero-token, local knowledge graph + vector memory** for AI agents, exposed as a standalone **MCP server**. Point a coding agent (Claude Code, Cursor, or anything else that speaks MCP) at it and it remembers permanently across sessions, restarts, and new chats - no LLM token spent to store or retrieve, no server to run. The default shape is as simple as that gets: one SQLite file, in-process embeddings, zero infrastructure.

The retrieval logic - including permissions - is native TypeScript, and every backend it talks to sits behind an interface. That means the same engine that runs locally on one machine can also scale up to a shared, multi-user deployment without touching the retrieval/ACL logic - see ["the seam"](#the-seam-one-interface-two-backends) below for how local mode and central-office mode split.

## Pipeline

Every `remember` / `recall` call runs this pipeline in-process - no LLM in the loop, and in local mode, no network hop either:

```
INGEST                                              QUERY
──────                                              ─────
text ─► record node + permission edges (ACL)        question ─► ACL: which records may this user see?
     ─► chunk ─► embed ─► vectors                             ─► vector search restricted to those records
     ─► extract entities + relations ─► graph                ─► rerank ─► cross-connector leak guard
                                                             ─► cited, permission-filtered snippets
```

Every stage is a single module behind an interface. Data flows as plain objects and a property graph (`nodes` + `edges`) - no shared mutable state, no side effects outside the SQLite file (local) or the configured backend (central).

## The seam: one interface, two backends

Chitta runs in two shapes from the same code:

- **Local mode (default)** - one SQLite file, in-process embeddings, zero servers. This is what a single developer or agent gets out of the box.
- **Central-office mode** - the same interfaces backed by ArangoDB + Qdrant + an HTTP embedding service, so a whole org can share one graph while each user still only sees what their ACL permits - useful once memory needs to scale past one person.

`src/provider.ts` defines the contracts (`GraphProvider`, `VectorDBService`, `EmbeddingProvider`). `src/service.ts` wires config → the right implementation. The **ACL + retrieval logic is identical** across modes - only the storage backend swaps.

| Capability | Local impl | Central impl |
|---|---|---|
| Property graph + ACL traversal | `embedded/sqlite-graph-provider.ts` (SQL) | `arango-graph-provider.ts` (AQL over HTTP) |
| Vector search | `embedded/sqlite-vec-service.ts` (sqlite-vec ANN, brute-force fallback) | `qdrant-vector.ts` (HTTP) |
| Embeddings | `embedded/local-embeddings.ts` (hashing) / `transformers-embeddings.ts` (ONNX `bge-*`) | `embeddings.ts` (OpenAI-compatible HTTP) |

## Module responsibilities

### Core (`src/`) - the portable retrieval/ACL moat

| Module | Responsibility |
|---|---|
| `provider.ts` | The interfaces every backend implements - the seam between logic and storage |
| `service.ts` | Wires env config → adapters → the native ACL/retrieval logic |
| `retrieval.ts` | Permission-filtered ranked search (`search_with_filters`) |
| `permission.ts` / `types.ts` | Permission model + shared data shapes |
| `config-env.ts` | Dep-free env config loader (identity + backend URLs) |
| `arango-client.ts` / `arango-graph-provider.ts` | Graph backend over ArangoDB's HTTP cursor API (no SDK) |
| `qdrant-vector.ts` | Vector backend over Qdrant's HTTP API (no SDK) |
| `embeddings.ts` | Dense embeddings via an OpenAI-compatible endpoint |

### Embedded stack (`src/embedded/`) - the zero-server, single-file path

| Module | Responsibility |
|---|---|
| `index.ts` | Assembles the embedded context stack (`buildEmbeddedContext`) |
| `sqlite-store.ts` | Schema: generic property graph (`nodes`, `edges`) + `chunks` + `vec_chunks` |
| `sqlite-graph-provider.ts` | ACL graph traversal ported from AQL to SQL |
| `sqlite-vec-service.ts` | Vector search; sqlite-vec ANN index when available, else brute-force cosine |
| `local-embeddings.ts` | Deterministic, dependency-free hashing embedder |
| `transformers-embeddings.ts` | Real semantic embeddings via transformers.js (ONNX, optional) |
| `ingest.ts` | Write side - creates the graph + vectors from input (chunking included) |
| `extract.ts` | Text → entity nodes + relationship edges (deterministic) |
| `llm-extractor.ts` | LLM-backed extraction via an OpenAI-compatible chat endpoint (higher recall) |
| `code-extractor.ts` | Source code → graph (the Graphify-style capability, TS-native) |
| `graph-query.ts` | Query the entity graph as a graph (traversal, neighborhoods) |
| `kgqa-service.ts` | Answer a question with the exact fact from the typed graph, not a ranked blob |
| `reranker.ts` | Cross-encoder rerank - the final, highest-precision retrieval stage |
| `authorizer.ts` | Write-side access control - the mutation counterpart to the read ACL |
| `graph/entity-resolution.ts` + `store/entities.ts` | **Entity resolution / coreference** - canonicalize surface-form variants ("Sarah"/"Sarah Chen") to one id (alias table + non-destructive merge) so the graph doesn't fragment |
| `memory/consolidate.ts` | Semantic facts → atomic memories: contradiction → version chain, **confidence-aware** belief revision |
| `memory/experience.ts` | **Episodic** memory (time-anchored events + actors + event-time) and **procedural** memory (trigger → action) |
| `memory/contradiction.ts` | **Semantic contradiction** detection (antonym table + negation) beyond single-valued predicates |
| `index.ts` cognition fns | `timeline`/`asOf` (temporal), `reflect` (insight synthesis), `dedupeEntities`/`sleep` (sleep-time consolidation) |
| `cli.ts` / `personal.ts` / `demo.ts` | Runnable entry points: standalone CLI (`ingest`/`query`/`sleep`/`doctor`…), persistent personal context, single-binary demo |

### MCP surface (`src/mcp/`)

| Module | Responsibility |
|---|---|
| `server.ts` | The MCP stdio server - exposes the tools below |
| `backend.ts` | Resolves which backend (local vs central) to talk to, from env |

### Evaluation (`src/eval/`)

| Module | Responsibility |
|---|---|
| `goldset.ts` | Build a Q→relevant-record eval set from your own stored data |
| `harness.ts` | Run a gold set through any retrieval function |
| `metrics.ts` | Pure retrieval metrics (precision/recall/MRR-style) over ranked ids |

## Tools exposed over MCP

| Tool | Does |
|---|---|
| `context_ingest` | Store text → record node + permission edges (ACL) + vector chunks + concept graph + atomic memories (semantic facts, **episodic** experiences, **procedural** how-tos) |
| `get_context` | Retrieve ranked, cited, permission-filtered snippets + current (contradiction-resolved) facts + relevant experiences + applicable preferences |
| `context_forget` | Forget memories no longer true/wanted (soft-delete, ACL-scoped) |
| `context_profile` | Profile a person/org/entity: permanent + recent facts + connections |
| `context_graph` | Return the knowledge graph (concepts + relationships) the user can access |
| `context_relate` | Graph queries over the entity graph (neighbors / path / impact / central / communities with summaries) |
| `context_timeline` | Reason over time: how a subject evolved, or the facts believed **as of** a past date (bi-temporal) |
| `context_reflect` | Synthesize higher-order insight: recurring focus, what changed, preferences, recent activity |
| `context_about` | Describe the server's mode, engines, config, and live counts |

## Storage schema (local mode)

One file at `$CONTEXT_DB` or `~/.local/share/100xprompt/context.db`:

| Table | Holds |
|---|---|
| `nodes` | Graph vertices - records (with write-time `importance`), users, orgs, **entities** |
| `edges` | Relationships - `permissions`, `belongsTo`, `mentions`, `relates_to` (bi-temporal) |
| `entity_aliases` | Surface-form slug → canonical entity id (coreference resolution / de-fragmentation) |
| `chunks` | Text + embedding vectors (compact Float32 BLOB) |
| `memories` | Atomic memories - `kind` (semantic/episodic/procedural), version chains (contradiction → supersede), `confidence` (belief revision), `occurred_at` (event time) + `actor_ids` (episodic), forgetting, static/dynamic |
| `audit` | Append-only, hash-chained access log (opt-in via `CHITTA_AUDIT`) |
| `vec_chunks` / `vec_native` | ANN index - sqlite-vec `vec0` (plaintext) or libSQL native DiskANN (encrypted) |

## Vector search - adaptive

If an extension-capable SQLite is available, the store loads [sqlite-vec](https://github.com/asg017/sqlite-vec) and keeps a `vec0` ANN index *in the same file* (~16× faster than brute-force at 3k vectors, more at scale). Otherwise it transparently falls back to brute-force cosine - same results, same interface. `store.vecEnabled` reflects the active path; no config required.

## The security invariant

This is what makes it safe to grow Chitta from one person's local memory into a shared team deployment - every read goes through the ACL graph **before** the vector index is touched: the graph answers *"which record ids may this user see?"*, and the vector search is restricted to that set. A final **cross-connector leak guard** prevents results from one source bleeding into another. The permission check is never a post-filter you can forget - it's the gate that produces the candidate set.

## Adding a new backend

1. Implement `GraphProvider`, `VectorDBService`, or `EmbeddingProvider` from `src/provider.ts`.
2. Register it in `src/service.ts` (and `src/mcp/backend.ts` if it's MCP-selectable) behind an env switch.
3. Keep the ACL/retrieval logic untouched - backends only move bytes; the moat stays in `retrieval.ts` + the graph providers.
4. Add a test under `test/` mirroring the source path (e.g. `test/embedded/your-provider.test.ts`).

## Testing

Tests live under `test/`, mirroring `src/`. Run:

```bash
bun test test/        # 228 tests across 41 files
```

All tests are self-contained - no external network calls; the MCP test spawns the real server over stdio and talks to it with the standard MCP client.
