# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
semantic versioning once it reaches 1.0.

## [Unreleased]

_Nothing yet._

## [0.7.4] - 2026-07-13

### Changed
- **`ask` now ranks its evidence by relevance, not by source.** Previously it filled the note
  budget graph-first, then facts, then search snippets - so on a large or noisy store the slots
  filled with loosely-matched typed triples before the hybrid-search passage that actually
  answered ever got one, and the answer was refused. Notes from all sources are now pooled
  (wider candidate pool), scored by query cosine, and the most relevant kept - a precise KGQA
  answer still ranks top, a loose one is demoted out.
- **The grounding gate holds every note to the cosine floor, including KGQA graph answers.** A
  loose typed match ("Talk likes pirate" for "coding preferences") no longer auto-grounds the
  answer; a precise one scores high and passes as before. Floor recalibrated to **0.55** (from
  0.6) against real queries - in-store answers phrased unlike the question (e.g. "User loves
  coding" for "my coding preferences" ≈ 0.72) cluster at 0.66-0.80, out-of-scope at 0.31-0.51,
  so 0.55 admits the former without the latter. `CONTEXT_ASK_FLOOR` overrides.
- **Source labels are no longer fed to the model**, only the note number + text. The label (a
  filename / record name) is shown in the citation footer; keeping it out of the prompt stops a
  small model echoing "(packages/…/foo.ts)" into its answer.

## [0.7.3] - 2026-07-13

### Fixed
- **A large store that changed embedders could stall in a mixed-dimension state.** When the
  active embedder's dimension differs from what a store was built with, the read-path self-heal
  (0.7.0) re-embedded every chunk inline on the first query. On a big store (100K+ chunks) that
  is minutes of work: it blocked the query, several processes sharing the DB (e.g. multiple MCP
  servers) could race the same migration, and an interrupt left the store half-converted (mixed
  256d/384d vectors), which degrades recall. Now:
  - **`reindex()` is resumable and reports progress.** Items already at the current embedder's
    dimension are reused as-is (only re-added to the rebuilt index); only stale-dim items are
    re-embedded. So a migration - or one interrupted half-way - finishes by doing just what's
    left, not everything again. `chitta reindex-vectors` shows a live `done/total (pct%)` line
    and reports `re-embedded N, reused M`.
  - **The read-path never launches a big migration inline.** Drift is detected by counting
    stale-dimension chunks (not sampling one row, which could miss a mixed store). A small drift
    still heals silently; a large one (over `CONTEXT_RECONCILE_INLINE_MAX`, default 3000) instead
    warns with the exact one-time fix and proceeds, so a query never blocks for minutes and
    processes don't race.
  - **`chitta doctor` flags a mixed-dimension store** and points at `chitta reindex-vectors`.

## [0.7.2] - 2026-07-13

### Fixed
- **`ask` citations leaked internal record ids.** Graph/snippet notes carried raw ids
  (`mem-…`, `rec-…`, `file:…`) as their source label, which cluttered the CLI citation footer
  and - because those labels are fed into the model prompt - made a small model sometimes echo
  them into its answer ("[1] (mem-abc…) Elon Musk lives in Texas"). A note's source label is now
  shown only when it is a real human name (a filename, a titled record); internal ids are
  stripped at the source, so both the prompt and the footer stay clean. Footer also reads
  "N memories" (proper plural) and drops the `.gguf` suffix from the model label. (391 tests.)

## [0.7.1] - 2026-07-13

### Fixed
- **`ask` could hallucinate on out-of-scope questions.** The default 0.5B model, handed only
  off-topic notes (e.g. asking "capital of Mongolia" against a store that is all about one
  person), would answer from its own pretraining and attach a fabricated `[n]` citation -
  breaking the core "answers only from your memory" promise. `ask` now runs a **deterministic
  relevance gate** before the model: unless a note clears a semantic-similarity floor (or a
  typed-graph exact answer exists), it returns "I don't have that in memory" **without invoking
  the model at all**, so it cannot answer from pretraining or fake a citation. When relevant
  notes do exist, a tightened prompt still refuses if the subject matches but the specific fact
  is absent. The floor (default 0.6, calibrated for `bge-small`) is tunable via
  `CONTEXT_ASK_FLOOR`, and is skipped on the lexical hash embedder whose cosine scale it does not
  calibrate for. Added `notesAreGrounded()` and an `EmbeddingProvider.isLexical()` marker; 7 new
  tests cover the gate (389 total).

## [0.7.0] - 2026-07-13

### Added
- **`chitta ask "question"` - one direct, cited answer, fully local.** Retrieval stays the
  zero-token pipeline (typed-graph exact answer + belief-revised facts + hybrid search); a tiny
  LLM running **inside the process** (llama.cpp bindings - no Ollama, no server, no API key) only
  phrases those notes and cites them as `[n]`. When memory has nothing relevant it answers
  *"I don't have that in memory"* - the model is never allowed to answer from its own
  pretraining, and it is not invoked at all on an empty result. The default model
  (Qwen2.5-0.5B instruct, ~0.4 GB) downloads once on first use; `--model <gguf path|url>` /
  `CONTEXT_ASK_MODEL` swap it, `CONTEXT_LLM_URL` routes `ask` to any OpenAI-compatible endpoint
  (Ollama, LM Studio, vLLM, cloud), and `--no-llm` prints the numbered notes with provenance
  instead. Measured: CLI answer in ~2-3 s; SDK repeat asks ~0.5 s (weights stay loaded).
- **SDK `memory.ask(question)`** - same answer layer for programs: returns
  `{ answer, sources, synthesized, model }`, streams via `onToken`, keeps the model warm across
  calls. `AskResult` / `AskNote` types exported.
- **`chitta warm`** - pre-download every lazy model in one command (embedder, reranker, ask
  model) with per-step timings, so first use is instant. Idempotent.
- `chitta doctor` now reports the ask layer: remote endpoint, local model ready, or
  "downloads on first ask".

### Changed
- **SDK single-user identity is now `local-user` / `local-org`** - the same identity the CLI and
  the MCP server use - so one store opened from any surface (SDK, `chitta` CLI, Claude's MCP
  tools) reads and writes the SAME memory. Before 0.7.0 the SDK default was `me`/`default-org`;
  stores written under that identity remain readable via `.user("me", { org: "default-org" })`.

### Fixed
- **Embedder drift now heals on READ, not only on ingest.** A store built with real embeddings
  but opened by an install where transformers can't load (or vice versa) reindexes itself to the
  active embedder on the first query/recall - previously the first *ingest* healed it but a
  read-only session silently searched a mismatched vector space. The heal also warns on stderr
  even when no logger is configured.

## [0.6.0] - 2026-07-13

### Changed
- **Real semantic embeddings (`bge-small`) are now the DEFAULT.** `@huggingface/transformers` is
  bundled (as an optionalDependency), so a default install does genuine semantic retrieval instead
  of silently falling back to the lexical keyword-hash embedder. This is the configuration the
  published benchmarks (0.552 LoCoMo recall@10, with the cross-encoder reranker) are measured with;
  the old default matched keywords, not meaning, and gave far weaker recall on natural-language
  queries. The model downloads once on first use. `CONTEXT_EMBEDDINGS=hash` keeps the previous
  instant, fully-offline lexical mode.
  - **Migration:** a store is tied to the embedder that built it. After upgrading, re-embed an
    existing (hash-built) store with `chitta reindex-vectors`, or start a fresh `chitta learn`.
- `chitta doctor` now reports the embedder that will **actually run** (real semantic vs a silent
  hash fallback when transformers is unavailable), not just the configured mode.

## [0.5.0] - 2026-07-13

The launch release: the whole 0.4.x line - repository learning (`chitta learn`), the visible
graph (`chitta graph --open`), usage-reinforced + working memory, multi-agent perspectives,
million-vector scale, and the MCP intelligence surface - consolidated, field-tested on real
multi-thousand-file repositories, plus one CLI fix.

### Fixed
- **`chitta query` could read the wrong database.** `learn` / `graph` / `doctor` default to the
  personal store, but `query` defaulted to `./context.db` in the working directory (and org
  `org1`) - so a bare `chitta query "..."` right after `chitta learn .` silently found nothing.
  Every command now resolves **one** store (`--db`, else `$CONTEXT_DB`, else the personal
  store), `--db` is honored uniformly (including by `learn`/`graph`), and `query` defaults to
  the personal identity. So `chitta learn .` then `chitta query "..."` just works, no flags.

## [0.4.2] - 2026-07-13

### Fixed
- **Code extraction silently no-opped in every npm-installed layout.** The tree-sitter
  grammar directory was located by a fixed relative path that only exists in a repo clone;
  under bunx / global / node_modules installs, hoisting moved `tree-sitter-wasms` elsewhere,
  the loader failed, and graceful degradation turned the code graph into an empty result
  with no error. Grammars are now located through real module resolution
  (`require.resolve`), with the old path kept as a fallback. Field-reported: a 33-code-file
  repo produced 16 concepts; the same walk now produces the full code graph.
- **`chitta learn` report was computed over the whole store, not the walk.** On a
  pre-populated personal store, "most-connected concepts" showed your old memories instead
  of the repo just learned. Hubs, relationship counts and clusters now come from the learned
  subgraph only (typed hub labels: `Billing (class)`, `app.py (file)`), and the store-growth
  delta is reported separately.

## [0.4.1] - 2026-07-13

### Fixed
- **The published CLI ran stale code.** The npm `bin` pointed at `dist/bin.js`, a pre-bundled
  build from 0.2.0 that was gitignored and silently packed as-is - so `bunx @100xprompt/chitta`
  delivered old behavior even though fresh `src/` shipped in the same tarball. The bin is now a
  3-line shim that imports `src/bin.ts` directly (Bun executes TypeScript natively), tracked in
  git, and it can never go stale again. `files` also narrowed from `dist` to `dist/bin.js` so a
  locally built compiled binary can never bloat a future tarball.

## [0.4.0] - 2026-07-13

The "advanced memory" release: the graph you can see, memory that learns from use, multi-agent
perspectives, million-vector scale, and an MCP surface that speaks up - all still zero-token.

### Added
- **`chitta graph --open`** (CLI) and **`Chitta.graphHtml()`** (SDK) - render the accessible
  knowledge graph to ONE self-contained interactive HTML file (force-directed, colored by type,
  sized by degree, search / zoom / hover). Safe to share: no CDN, no requests, XSS-escaped.
- **Usage-reinforced memory strength** - recalled memories strengthen (`use_count`,
  `last_used_at`; safe migration for existing DBs) and ranking becomes recency x frequency x
  importance with an exponential half-life (`CONTEXT_MEMORY_HALFLIFE_DAYS`, default 30).
  Weak memories are outranked, never deleted; `CONTEXT_MEMORY_REINFORCE=0` restores the
  legacy ordering byte-for-byte.
- **Working memory** (`WorkingMemory`) - a session-scoped tier whose `consolidate()` promotes
  only what survived the session (repeated, marked important, or referenced twice - deterministic,
  no LLM) through the existing belief-revision path; the rest is dropped, stale sessions expire
  (`CONTEXT_WM_TTL_HOURS`, default 24).
- **Multi-agent memory perspectives** - `chitta.agent(id)` (namespaced `agent:` principals),
  `chitta.team(id, { agents })`, `shareWithTeam`, and `chitta.perspectives.diff(a, b)` /
  `.shared([...])` - belief set-operations over each principal's provenance-filtered subgraph.
  The multi-tenant ACL applied to agents; no new machinery.
- **PPR multi-hop retrieval** (`CONTEXT_GRAPH_PPR`, default off) - HippoRAG-style Personalized
  PageRank over the typed entity graph, fail-closed on the same ACL provenance invariant, fused
  as a 4th RRF leg. Off by default because full LoCoMo Tier-A measurement showed neutral there
  (its multi-hop questions are a 1-hop ranking problem); the synthetic suite proves it reaches
  3-hop evidence the bounded hop cannot. Enable for corpora with genuine typed chains.
- **Self-calibrating two-stage vector search** - stage 1 scans prefix-renormalized embedding
  prefixes (optionally int8 via `CONTEXT_VEC_INT8`) and stage 2 rescores the shortlist at full
  dimension, with per-corpus recall calibration (target >= 0.95). Measured: 500K vectors
  1,754ms -> 145ms (12.1x) at recall 1.000; auto-off below ~4K rows.
- **MCP intelligence surface** - `context_ingest` responses announce belief revisions
  ("note: this superseded a previous belief..."); read-only MCP **resources**
  (`memory://graph`, `memory://stats`, `memory://profile/{entity}`, ACL-filtered and audited);
  new **`context_health`** tool (store stats, memory kinds, engine status, top concepts).
- Community health: `CODE_OF_CONDUCT.md`, Dependabot config (with honest pins), seeded
  good-first-issues, launch docs under `docs/launch/`.

### Changed
- `actions/checkout` v4 -> v7 across workflows; the publish workflow now skips gracefully (with
  a loud warning) when `NPM_TOKEN` is not configured instead of failing the release red.
- Code extractor speaks both web-tree-sitter APIs (<=0.24 and >=0.25); the dependency stays
  pinned at 0.24.7 because every published grammar bundle (tree-sitter-wasms <= 0.1.13) is
  rejected by the 0.25+ loader - upgrading becomes a one-line bump once a compatible bundle
  ships.

## [0.3.0] - 2026-07-12

This cycle makes Chitta an embeddable, production-ready memory layer and proves it **scales**.
It ships an ergonomic **SDK**, framework **tool adapters**, typed errors + observability, and
CI/publish automation - on top of an engine hardened to be **sub-linear**: O(1)-in-N graph
retrieval, near-linearithmic ingest, ACL-first filtered-ANN, and an opt-in plaintext DiskANN
index. It also lands the full **deep-memory cognition program** (entity resolution,
episodic/procedural memory, temporal reasoning, self-correction) and a real memory-benchmark
framework (both detailed in the sub-sections below).

### Added

- **The Chitta SDK - an ergonomic, importable API.** `new Chitta({ path })` gives an in-process,
  permission-aware, **zero-token** knowledge-graph + vector memory with no servers and no config:
  `remember` / `rememberMany` / `recall` / `facts` / `recallAll` / `forget` / `profile` /
  `timeline` / `asOf` / `graph.*`, plus `.user(id)` for multi-tenant per-user ACL and `.ctx` as a
  low-level escape hatch. Fully typed (`ChittaOptions` / `RememberOptions` / `Recalled` / `Entity` /
  `Relation`) and exported from the package root and `@100xprompt/chitta/sdk`. Docs:
  [docs/SDK.md](docs/SDK.md), [docs/API.md](docs/API.md).
- **`rememberMany`** - batch ingest; each item is a full `remember` (its own record + typed graph),
  returning the ids in input order.
- **Framework tool adapters (`chittaTools`).** Dependency-free `{ rememberMemory, recallMemory }`
  tool definitions (`description` + JSON-Schema `parameters` + async `execute`) shaped as the common
  denominator across the **Vercel AI SDK**, **OpenAI**, and **Anthropic** tool APIs - pass a
  `.user(id)` for per-user ACL. `@100xprompt/chitta/adapters/ai-tools`; docs
  [docs/adapters.md](docs/adapters.md).
- **Typed errors + fail-fast config validation.** A tiny error hierarchy - `ChittaError` (stable,
  machine-readable `err.code`) and `ConfigError` - plus `ChittaOptions` validation at construction,
  so a bad `embeddings` mode or empty `path` throws an actionable message instead of failing deep in
  the engine.
- **`onEvent` observability hook.** Fired after `remember` / `recall` / `facts` with
  `{ op, ms, count? }`; guarded and try/catch-wrapped (a throwing handler can never break a call) and
  zero-overhead when unset.
- **Temporal-validity-aware ranking (zero-token).** Retrieval prefers currently-valid facts over
  superseded ones, so time-sensitive answers track the latest truth without an LLM in the loop.
- **Query-entity-anchored graph multi-hop (zero-token).** A query that names a known entity seeds a
  **bounded** multi-hop expansion from that entity's node; plus pseudo-relevance-feedback (PRF)
  second-hop recall. Seeding is bounded and the typed extractor hardened.
- **LLM-free typed relations.** The deterministic extractor now activates the full cognition stack
  (typed triples, belief revision, memory typology) with **zero tokens**.
- **Scaling flags.** `CONTEXT_DISKANN=1` (plaintext native DiskANN, opt-in),
  `CONTEXT_EMBED_PROFILE` (one-liner model upgrade: `fast` | `english-large` | `multilingual` |
  `on-device`), `CONTEXT_FILTER_FIRST_MAX` (filtered-ANN threshold, default 2000),
  `CONTEXT_GRAPH_BOUNDED` (bounded graph hop).
- **CI / publish / benchmark workflows + deployment docs.** `.github/workflows/ci.yml` (typecheck +
  `bun test` on push/PR), `publish.yml` (GitHub Release → gated `bun test` → `bun publish`, via the
  `NPM_TOKEN` secret), and `benchmark.yml`. New [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md),
  [docs/PERFORMANCE.md](docs/PERFORMANCE.md), and [docs/RELEASING.md](docs/RELEASING.md).

### Changed

- **Filtered-ANN is the default dense path for scoped users.** When a user's accessible set is
  selective (≤ `CONTEXT_FILTER_FIRST_MAX`, default 2000), the dense stage scans **exactly the
  accessible vectors** (via a `virtual_record_id` index) - O(accessible), **leak-proof by
  construction**, and still exact. No flag; measured recall is **identical (Δ = 0)**.
- **Blend-rerank option** - recall-preserving rank fusion, wired into the reranker and the benchmark.

### Performance

- **Graph retrieval is O(1) in graph size.** The `relates_to` expansion is now **bounded**, so
  latency stays flat (~0.05 ms) from 50K→100K records where an unbounded hop climbs to ~2 ms -
  **≈39× faster at 100K**, with recall **+0.6%** on LoCoMo Tier-A (bounding also trims off-topic
  expansion). Toggle `CONTEXT_GRAPH_BOUNDED`.
- **Ingest O(N²) → ~O(N log N).** Belief-revision + ACL checks are now **change-proportional**
  (driven by the record being written, not the whole corpus): ~16× more data for only ~2.9× the
  per-record cost (0.60 ms @1K → 1.72 ms @16K), where the old path grew quadratically and timed out
  by 20K.
- **Plaintext DiskANN (opt-in, `CONTEXT_DISKANN=1`).** libSQL's native DiskANN, in plaintext, keeps
  ANN latency **flat (~8 ms)** vs `vec0`'s linear growth (51 ms @100K → ~6×), at 0.98 top-10 recall
  overlap. Honest tradeoff: ~80× per-vector ingest cost and an ~8 ms query floor - for **large,
  read-heavy, static** corpora only (`vec0` still wins below the ~15-18K crossover). Never a default.

### Fixed

- **Bounded / hardened query-entity graph seeding** and a hardened deterministic typed extractor.
- **Benchmark fidelity** - attribute each turn with speaker + date, and ingest the session/event
  date into memory; the Tier-B LLM client accepts full endpoint URLs + `max_tokens`; a `--max-q`
  question cap enables cheap Tier-B iteration.

### Added - Deep-memory program (cognition layer)

- **Stage 1 - Canonical graph (entity resolution / coreference).** Entity ids were
  `slugify(name)`, so "Sarah", "Sarah Chen" and "Ms. Chen" fragmented into three separate
  nodes - silently corrupting every graph query, profile, and memory subject_key. New
  canonicalization layer decides the ONE canonical entity id a surface form belongs to:
  - `graph/entity-resolution.ts` - pure, deterministic, **high-precision** matching:
    normalized equality (legal-suffix / honorific / punctuation folding), acronym ↔
    expansion ("IBM" ↔ "International Business Machines"), transposition-aware (Damerau)
    typo matching, and **type-gated** name containment ("Sarah" ⊆ "Sarah Chen" merges only
    for PERSON, never for concepts/products - so "100X Pro" vs "100X Flash" stay distinct).
    A PERSON is never merged into an ORG. Embeddings can only *confirm* a plausible string
    signal, never trigger a merge alone (keeps the offline path deterministic).
  - `store/entities.ts` - an `entity_aliases` table (O(1) fast path per surface form) +
    `mergeEntities` that folds two already-separate canonicals **non-destructively**:
    re-points edges (weights accumulate, provenance unions, a fact live on either side
    stays live) and rewrites memory `subject_key`s (reconciling any is_latest collision).
  - Threaded through **both** the graph write path (`ingest.ts`) **and** the living-memory
    subject keys (`consolidate.ts`) so they share canonical ids - which means a
    contradiction asserted under a *different surface form* now correctly supersedes
    (works_at: "Sarah Chen"→Meta, then "Sarah"→OpenAI resolves to one fact).
  - `dedupeEntities()` - a retroactive, idempotent backfill pass to canonicalize
    pre-resolution data. Labels converge upward to the most specific surface form.
  - +9 tests (`test/embedded/entity-resolution.test.ts`); full suite 205 → 214, green.

- **Stage 2 - Memory typology (episodic + procedural).** The store held only timeless
  SEMANTIC facts. Added the other two human memory kinds, in the same ACL-scoped table
  (`kind` column, migrated idempotently; existing rows default to `semantic`):
  - **Episodic** - time-anchored experiences ("met Sarah at the Anthropic office on
    2026-07-01"). A distinct `occurred_at` **event-time** axis (separate from ingestion
    time → memories are now bi-temporal), and `actor_ids` linking each episode to the
    **canonical entities** from Stage 1 (so "the last time I spoke with Sarah" resolves
    Sarah → her node → her episodes). Each episode is distinct - never superseded - and is
    recalled by **relevance × recency** (ACT-R). Idempotent per record.
  - **Procedural** - learned how-tos / preferences (trigger → action); a new action for the
    same trigger **supersedes** (versioned, history kept), like a functional fact.
  - `memory/experience.ts` engine; `store/memories.ts` gains kind-scoped `recallEpisodes` /
    `recallProcedures` / per-kind `kinds()` counts; ingest steps (6)/(7) create them.
  - MCP: `context_ingest` accepts `episodes` + `procedures`; `get_context` surfaces
    "Relevant experiences" + "Applicable how-tos / preferences" sections; stats report
    per-kind counts. +4 tests (`test/embedded/experience.test.ts`); suite 214 → 218, green.

- **Stage 3 - Reflection + temporal reasoning.** The store was bi-temporal but had no way to
  *query* time, and rolled facts up but never *reflected*:
  - **Temporal query surface** over the version chains: `factsAsOf` (memory time-travel -
    the beliefs held at a past transaction time), `subjectHistory` + `episodesForActor`
    → `timeline(subject)` (how X evolved: every fact change interleaved with the experiences
    involving it, chronological, superseded versions marked).
  - **Reflection** (`reflect`) - deterministic, ACL-scoped insight synthesis: recurring focus
    (most-connected entities), what CHANGED (version chains), known preferences (procedural),
    recent activity (episodic). Computed on-demand per user over the accessible set, so it is
    ACL-correct by construction and never persisted (a stored insight could span records with
    different permissions).
  - **GraphRAG community summaries** - every cluster now carries a human-readable summary
    (hub + top members + the predicates that bind it), surfaced by `context_relate communities`.
  - MCP: new `context_timeline` (timeline / as-of) and `context_reflect` tools (10 total).
    +5 tests (`test/embedded/temporal.test.ts`); suite 218 → 223, green.

- **Stage 4 - Self-correcting memory.** The store now maintains its own truth:
  - **Importance scoring at write** - `computeImportance` seeds each record's salience from
    typed-knowledge density, entity count, experiential content, and consequential cue words
    (the decay/salience re-ranker read `importance` but only ever saw the default 1).
  - **Confidence-aware belief revision** - memories carry a `confidence`; a newer functional
    value supersedes only when it's at least as confident, so a weak rumor can't overwrite a
    high-confidence belief (defaults keep recency-wins behavior, fully compatible).
  - **Semantic contradiction detection** (`memory/contradiction.ts`) - opposite-polarity
    facts about the same (subject, object) that functional supersession can't catch
    ("likes" vs "dislikes", or negated "no_longer_likes") retire the older belief. An
    explicit antonym table + negation normalization - deterministic, never fires on merely
    different facts.
  - **Sleep-time consolidation** (`ctx.sleep()`, `chitta sleep`) - an idempotent background
    pass that dedupes entities (Stage 1), retires expired dynamic memories, and re-weights
    record importance by CORROBORATION (a fact many records attest to matters more).
  - `context_about` now fully self-describes the cognition layer. +5 tests
    (`test/embedded/self-correcting.test.ts`); suite 223 → 228, green.

### Added - benchmarking framework

- **A real memory-benchmark framework** (`src/eval/bench/` + `src/eval/datasets/`, `chitta bench`) -
  measures memory the way the field does: end-to-end QA over a long history, broken down by reasoning
  category, not one blended number.
  - **Tier A** (retrieval, no LLM, deterministic): recall@k / nDCG@k / MRR / P@k **per category**
    (reuses `metrics.ts`) - isolates "is the memory surfacing the right evidence" from generation.
  - **Tier B** (end-to-end QA): grounded, abstention-aware LLM answer + **LLM-as-judge**, accuracy per
    category. Injected as a dependency, so Tier A needs no LLM and tests use deterministic stubs.
  - **Datasets:** built-in offline `synthetic` (all five LongMemEval categories incl. knowledge-update
    + temporal), plus `longmemeval` / `locomo` loaders (schemas verified against the source repos),
    all behind one normalized schema (`DatasetLoader`).
  - **Efficiency:** context-tokens-per-question vs full-history (token-reduction ratio) + latency.
  - Scorecard → console / markdown / json. `chitta bench <dataset> [--tier a|b|both] [--k] [--limit]
    [--path] [--report]`. Docs: `docs/BENCHMARKING.md`. Built via 2 parallel subagents (dataset loaders,
    Tier-B QA/judge) on disjoint files. +24 tests; suite 246 → **270**, typecheck clean.

### Fixed / hardened - robustness pass

- **Permission-scoped belief revision (correctness fix).** Memory supersession + contradiction
  keyed on a global `subject_key` with no ACL filter, so inside one org DB **one user's ingest
  could silently clobber another user's PRIVATE current memory** (proven: Alice's private
  "Sarah works at Meta" vanished when Bob privately ingested "…Google"). `latestBySubject` now
  takes a `scopeVids` gate; `authorizedIngest` passes the writer's accessible records (∪ the new
  record) so **private stays private, shared/org-wide still updates once for all**, and
  intra-record contradictions still resolve. +3 multi-user regression tests.
- **Community detection: union-find → Label Propagation.** Connected-components collapsed any
  densely-wired graph into one useless "cluster of 900"; deterministic weighted async LPA now
  recovers modular structure (two groups joined by a lone bridge stay separate). Same API/summary.
- **Entity resolution hardened.** Nickname folding (Bob↔Robert, Liz↔Elizabeth; PERSON-gated) +
  abbreviation normalization (Dept→Department, Intl→International, `&`→and); and an indexed
  `entity_tokens` blocking table **replaces the O(N) `LIKE` scan** on every ingest.
- **Measurement.** New `test/eval/deep-memory-benchmark.test.ts` quantifies the cognition layer:
  entity-resolution fragmentation **1.000** (17 surface forms → 6 canonical nodes), contradiction
  resolution **6/6**, retrieval recall@5/MRR/nDCG **1.000** (goldset saturated - harder paraphrase
  queries flagged as future work). Suite 228 → **246**, typecheck clean.

## [0.1.13] - 2026-06-29

### Changed
- **`context_about` is now a complete self-description (the one discovery endpoint).** Its
  overview previously covered only retrieval + the bi-temporal graph; it now also summarizes
  the **living-memory layer** (atomic memories, version chains/contradiction resolution,
  static-vs-dynamic, forgetting + TTL, profiles) and the **security guarantees** (gate-first
  ACL with zero cross-user/per-edge leak, `<untrusted_memory>` memory-poisoning defense,
  Trojan-Source sanitization, optional encryption-at-rest + `chitta rekey`, tamper-evident
  audit). It already auto-lists all 7 tools (from the live registry, so never stale) plus
  mode/identity/storage/engines/encryption/audit/live counts - so a single `context_about`
  call now tells a client everything the server can do.

## [0.1.12] - 2026-06-29

### Docs
- **Accuracy pass on shipped docs.** The skill (`assets/skill/SKILL.md`) and `ARCHITECTURE.md`
  listed only 3 of the 7 MCP tools - updated to include `context_forget`, `context_profile`,
  `context_relate`, `context_about`, with when-to-use guidance. README now documents the
  operational CLI (`chitta doctor`, `chitta audit [--verify]`, `chitta rekey`) with the
  **correct** rekey usage (the current key comes from `CONTEXT_DB_KEY`, not an `--old-key`
  flag). Storage-schema tables now list `memories`, `audit`, and `vec_native`, and note
  embeddings are Float32 BLOBs. Test-count badge refreshed (205). The `install` success
  message lists the full tool set and points to `chitta doctor`.

### Performance
- **~3.9× faster `get_context` via ACL/graph memoization (zero algorithm change).** A single
  `get_context` recomputed the two expensive, side-effect-free provider lookups
  (`getAccessibleVirtualRecordIds`, `getKnowledgeGraph`) up to 4× - once each in KGQA, memory
  recall, neighborhood, and hybrid search - and again on every repeat query. They're now
  memoized in `SqliteGraphProvider`, keyed by a monotonic **store data-version** that bumps on
  every nodes/edges mutation, so a cache hit is byte-identical to a fresh computation and **no
  stale permission view is possible** (any write that could change access invalidates the
  cache; salience/decay writes deliberately don't, so read-time decay can't thrash it).
  Measured A/B on identical data at 5k docs: ~436 ms → ~112 ms (**3.9×**); repeat queries with
  no writes between benefit further. KGQA, RRF/hybrid retrieval, GraphRAG, rerank, memory, and
  the ACL semantics are all unchanged. Regression: `test/security/acl-cache.test.ts` proves
  invalidation (newly-shared record becomes visible, deleted record disappears, new graph
  relation appears) right after a cached read; the ACL red-team probe + multiuser suites still
  pass.

## [0.1.10] - 2026-06-29

### Fixed
- **`rekey` (encryption rotation) could fail copying BLOB columns across drivers.** A BLOB
  read from the libSQL driver comes back as an `ArrayBuffer`, which `bun:sqlite` refuses to
  bind; `copyTable` now coerces `ArrayBuffer` → `Uint8Array` so encrypt/decrypt rotation
  works in both directions. Caught by running the (previously libsql-gated) rekey roundtrip.

### Changed
- **`libsql` added as a devDependency** so the encryption suite actually runs in CI: the
  encryption-at-rest, rekey encrypt/decrypt roundtrip, and **native DiskANN-under-encryption**
  tests are no longer skipped - they pass, verifying the Tier-2 encrypted-ANN path end to end.
  (It remains an *opt-in runtime* extra for users - `bun add libsql` - and does NOT ship in
  the published package.)

## [0.1.9] - 2026-06-29

### Added
- **One-step configuration at install time.** Every config knob is now an `install` flag,
  baked into the tool's MCP `env` block (works the same across all 15 tools):
  `--user-id --org-id --role --groups` (identity/ACL), `--db`, `--embeddings`/`--embed-model`,
  `--db-key` (encryption at rest, with a plaintext-in-config security warning), `--audit`
  (tamper-evident log), `--memory-ttl`, `--llm-url`/`--llm-model`, `--topk`, `--rerank`.
  `chitta install --list` now prints the full flag reference. (Previously only `--user-id`/
  `--org-id` were exposed; the rest required hand-editing env.)
- **`chitta doctor` - configuration & health at a glance.** Shows the effective setup the
  MCP server runs with: identity/role/groups, storage path, encryption on/off, vector-ANN
  vs brute-force, embeddings mode, reranker, audit on/off (+ chain integrity), memory TTL,
  LLM extraction, and live record/chunk/entity/memory counts - plus actionable warnings
  (e.g. `CONTEXT_DB_KEY` set but `libsql` not installed). One command to verify a deployment.

## [0.1.8] - 2026-06-29

### Performance
- **Embeddings stored as compact Float32 BLOBs, not JSON TEXT.** The brute-force vector
  path no longer `JSON.parse`s every vector on every query (the dominant cost) - embeddings
  decode zero-copy as `Float32Array` views, scored by dot product (== cosine for our
  normalized embedders, skipping the per-row sqrt), with a bounded top-k selector instead of
  a full O(N log N) sort. ~2-3x smaller on disk (fewer pages to decrypt under encryption).
  Measured brute-force top-8: ~1.4 ms @1k, ~15 ms @10k vectors. Existing DBs are read
  back-compatibly (legacy JSON-TEXT still decodes) and rewritten as BLOB on reindex/ingest.
  New `src/embedded/store/vector-blob.ts`; `test/embedded/vector-blob.test.ts`.
- **Real ANN under encryption (libSQL native DiskANN).** Encrypted mode can't load the
  `sqlite-vec` extension, but libSQL has a native vector index built into the engine - so
  encrypted retrieval now uses `F32_BLOB` + `libsql_vector_idx` + `vector_top_k` (ANN inside
  the encrypted file, no extension), removing the prior "encryption ⇒ brute force only"
  limitation. Falls back transparently to the (now fast) BLOB brute-force path if native
  vector is unavailable, so encrypted mode can't break. `store.annEnabled` reflects which
  path is active; `test/security/encryption.test.ts` (gated on `libsql`) asserts native ANN
  engages under encryption.
- **Read-latency pragmas**: 256 MB page `cache_size` (the main lever for the encrypted
  driver - decrypt paid once per page, then cache-served), `synchronous=NORMAL`,
  `temp_store=MEMORY`, and `mmap_size=1 GB` on the plaintext path (a no-op under encryption,
  so it's only set there).

## [0.1.7] - 2026-06-29

### Security
- **Tamper-evident audit logging (opt-in, `CHITTA_AUDIT=1`).** Every tool call (ingest /
  recall / forget / profile / graph) is appended to an `audit` table recording **who**
  (`CONTEXT_USER_ID` + org), **what** (tool + redacted summary), **when**, and success/denied.
  Each entry is **hash-chained** to the previous (`sha256(prev_hash + entry)`), so any later
  edit/delete/reorder breaks the chain - `chitta audit --verify` walks it and reports the
  first broken id (tamper-evident even against DB-write access). **Privacy-preserving:** raw
  stored content never enters the trail - ingests log title + byte size, reads log the
  query/subject intent only. Inspect with `chitta audit [--tail N]`; encrypted with the store
  when `CONTEXT_DB_KEY` is set. Off by default (personal use stays zero-overhead/private).
  New `src/embedded/store/audit.ts`, `src/mcp/audit-redact.ts`; `test/security/audit.test.ts`.
- **Encryption key rotation (`chitta rekey`).** Re-encrypt the whole store under a new
  `CONTEXT_DB_KEY` (or `--new-key ''` to decrypt back to plaintext) via a logical
  re-encryption copy + atomic file swap, keeping a timestamped backup. Audit hash-chain,
  version chains, validity intervals, and provenance are all preserved.
  New `src/embedded/store/rekey.ts`; `test/security/rekey.test.ts` (plaintext roundtrip
  always runs; encrypt/decrypt roundtrip gated on the optional `libsql`).
- **`SECURITY.md` deployment-hardening checklist** documenting the infra-layer controls
  (TLS in transit, per-IP rate limiting, network allowlist/authn, secret handling, audit
  retention) that belong at the proxy/infra layer rather than in a local stdio server.
- `context_about` now reports encryption-at-rest and audit-log status.

## [0.1.6] - 2026-06-29

### Fixed
- **Atomic memories not populated for pre-existing data (`context_profile` looked empty /
  redundant; `context_about` showed "0 current memories").** Memories were only consolidated
  at ingest from newly-supplied triples, so a DB whose typed graph predated the memory layer
  (or was built via the LLM extractor) had graph edges but **no atomic memories** - making
  `context_profile` collapse to just "Connected to …" (less than `context_relate`). Added
  `rebuildMemories()` which backfills the memory layer from every LIVE typed edge (resolving
  entity labels + the asserting record's ACL anchor), wired into `context_rebuild`, plus a
  one-time **self-heal**: `recallMemories` / `buildProfile` / `forgetMemories` auto-backfill
  on first use when the memory table is empty but typed facts exist. Now `context_profile`
  returns the promised permanent/recent fact synthesis on existing DBs with no manual step.
  Regressions: `test/embedded/memory.test.ts` (self-heal + explicit rebuild).

## [0.1.5] - 2026-06-29

### Added
- **Profile synthesis (`context_profile`).** Rolls up everything currently known about a
  person/org/entity into a compact, structured view - **permanent** facts (static), **recent**
  facts (dynamic, newest first, contradictions already resolved + forgotten excluded), and the
  entities it's most **connected** to. Supermemory's "user profile", but generalized to ANY
  principal/entity the caller is permitted to see (not just self) and built only from the
  caller's accessible memories + graph. `buildProfile()` on the embedded context;
  `test/embedded/memory.test.ts` covers static/dynamic split + cross-user ACL.
- **Stronger zero-dependency default embedder (hashing v2).** The offline default is no
  longer a plain bag-of-words hash: it now also hashes **character n-grams** (morphological
  overlap - "running"~"run", graceful typo degradation) and **word bigrams** (phrase signal),
  with signed feature hashing and sublinear term weighting, at 256 dims (was 64). Materially
  better recall with still zero downloads; real neural embeddings remain a one-flag opt-in
  (`CONTEXT_EMBEDDINGS=real`). The dim change is handled automatically for existing DBs by the
  embedder-drift `reconcile()` (detects + reindexes). `test/embedded/local-embeddings.test.ts`.
- **Living memory - permission-aware atomic memories (the Supermemory-parity layer, but
  ACL-scoped).** A new first-class memory layer on top of the typed graph: ingested typed
  triples are consolidated into **atomic memories** with full version chains, forgetting,
  and a static-vs-dynamic distinction - all gated by the same ACL invariant as the rest of
  retrieval (you can only ever recall or forget what you're permitted to see).
  - *Contradiction → versioning:* a new single-valued fact that conflicts with the current
    one (e.g. `works_at`: Google → Meta) **supersedes** it - the old version's `is_latest`
    flips, a new version (+1) is linked via the chain, and recall returns only the current
    truth. History is never deleted (`memoryHistory(root)` returns the full v1→vN chain).
  - *Forgetting:* new `context_forget` MCP tool soft-deletes memories matching a natural-
    language description (semantic + substring), within the caller's accessible set only;
    it's **coherent** - the underlying typed graph edge is expired too, so KGQA / graph
    queries also stop asserting it. Optional TTL via `CONTEXT_MEMORY_TTL_DAYS` retires
    dynamic memories on a lazy sweep; static facts (names, birthplaces) are exempt.
  - *Retrieval:* `get_context` now includes a **"Current memory (latest, contradictions
    resolved)"** section - the deduped, forgetting-aware view, distinct from the raw graph
    neighborhood and ranked snippets. `context_about` reports live memory counts.
  - New: `src/embedded/store/memories.ts` (repo), `src/embedded/memory/consolidate.ts`
    (the consolidation engine), `migrateMemories` (idempotent schema), `recallMemories` /
    `forgetMemories` / `memoryHistory` on the embedded context, `store.expireEdges`, and the
    `context_forget` tool. Regressions: `test/embedded/memory.test.ts` (contradiction,
    dedup, forgetting, TTL, **cross-user ACL isolation**) + `test/mcp/get-context.test.ts`.
    No LLM required - it consolidates the precise typed triples the calling model already
    supplies; memory embeddings are re-embedded on embedder drift via `reindex()`.

## [0.1.4] - 2026-06-28

### Fixed
- **`get_context` breadth recall topped out at ~73% (missed graph-neighbor facts).** Even
  after the additive-KGQA fix, ranked retrieval is inherently lossy (topk-capped,
  similarity-ordered), so typed-graph neighbors that aren't lexically/semantically close to
  the query (e.g. for "everything about Elon Musk": *X Corp, DOGE, Grimes, Vivian Wilson*)
  never surfaced - `context_relate(neighbors)` returned them but `get_context` didn't. Now
  when a query **names a known entity**, `get_context` folds in that entity's **complete
  typed neighborhood** (the same full edge set as `context_relate`) as an additive "Related
  facts about X" section. Gated to breadth queries or when KGQA found no precise answer, so a
  narrow factual question stays focused. New `GraphQueryService.neighborsForQuery`
  (free-text → named entity → full neighborhood) + `backend.relatedFacts`. Regressions:
  `test/embedded/graph-query.test.ts`, `test/mcp/get-context.test.ts`.
- **`bunx` launch failure / "server disconnected" + 2.4 GB install.** `@huggingface/transformers`
  (~2.4 GB) and `libsql` were `optionalDependencies`, so `bunx @100xprompt/chitta` tried to
  download them on every launch - failing on tight disks and bloating installs. They're now
  **opt-in extras** (`bun add @huggingface/transformers` / `bun add libsql`); the published
  package installs only the ~55 MB core. The default `auto` embedder uses real embeddings when
  the package is present, else the fast hashing embedder. (Encryption + reranker code unchanged;
  both lazy-import and degrade gracefully when the extra isn't installed.)
- **`get_context` incompleteness (was returning ~20% of relevant context).** Two causes:
  (1) a **KGQA short-circuit** returned only the 1-few exact typed-graph facts and skipped the
  ranked retrieval entirely; (2) the final cut was **`topk=6`**. Now `get_context` is
  **additive** - the precise typed-graph answer is a highlight *on top of* the full ranked
  recall (vector + BM25 + GraphRAG), default `topk` raised to 8, breadth queries ("everything
  about X", "all/list …") auto-widen to 20, and a `limit` arg (≤50) is exposed and threaded
  through `searchWithGraph`/`hybridSearch`. Regression: `test/mcp/get-context.test.ts`.
  (For an exhaustive entity relationship map, `context_graph` remains the right tool.)
- **Embedding dimension-mismatch crash.** Ingesting/querying a DB whose stored vectors were
  written by a different embedder (e.g. real bge-384 vs hashing-64) threw "expected 384, got
  64" on the `vec0` insert and crashed `context_ingest`. The store now self-heals: the vec
  write is crash-proof, and a one-time `reconcile()` detects the dim change and reindexes the
  whole DB to the current embedder (wired into ingest + query). Regression:
  `test/embedded/embedder-drift.test.ts`.

### Security
- **Hardening bundle - ahead-of-field defenses (`src/security/`):**
  - *Memory-poisoning / indirect prompt injection:* `get_context` now returns recalled
    snippets wrapped in `<untrusted_memory>` tags with a "treat as data, not instructions"
    preamble (spotlighting; optional datamarking via `CHITTA_SPOTLIGHT=datamark`). No major
    memory system (mem0/Letta/Zep/cognee/OpenMemory) does this.
  - *Input sanitization:* ingested text + all labels are stripped of bidi (Trojan Source,
    CVE-2021-42574), zero-width, and control chars (NFC-normalized, length-capped) at write
    **and** output time.
  - *Ingest limits:* per-payload size cap (10 MB, `CHITTA_MAX_INGEST_BYTES`) in core ingest;
    token-bucket rate limit on the external `context_ingest` MCP surface.
  - *ACL red-team probe suite* (`test/security/acl-probe.test.ts`): cross-tenant leakage
    (CTLR==0), identity-not-query injection invariance, deny-by-default - runs in CI.
  - `SECURITY.md` expanded with the threat model + the encryption-at-rest posture.
- **ACL integrity fix (critical):** extracted knowledge-graph entities shared the `nodes`
  table keyspace with principals (users/orgs/groups) and records. Because entity ids are
  slugs of free text written with `INSERT OR REPLACE`, ingesting a document that merely
  *mentioned* a word matching a principal id (e.g. a doc saying "Alice…" when `alice` is a
  user) would overwrite that principal's node and silently strip their access. Entity ids
  are now namespaced (`entity:`) into a separate keyspace, making the collision
  impossible. Added a regression test
  (`test/embedded/multiuser.test.ts` → "ACL integrity - ingested entities cannot clobber
  principals").

### Added
- **Encryption at rest (opt-in, transparent).** Set `CONTEXT_DB_KEY` and the store opens via
  libSQL with whole-file AES-256 encryption - the `.db` is ciphertext on disk; graph, ACL,
  FTS, and vector search keep working. Default (no key) stays plain `bun:sqlite` with the ANN
  index, untouched. Trade-off: the encrypted driver can't load `sqlite-vec`, so encrypted
  mode uses brute-force cosine (no ANN speedup). New `src/embedded/store/db.ts` driver
  abstraction; `libsql` optional dependency; `test/security/encryption.test.ts` proves
  plaintext never hits disk. (Required a one-line validated-literal `vec0` write to dodge a
  libSQL bound-param panic - confined to the encrypted path.)
- **Real semantic embeddings by default.** `buildEmbeddedContext` now selects embeddings via
  `CONTEXT_EMBEDDINGS` (default `auto`): real transformers.js embeddings (`bge-*`) when
  loadable, automatic fallback to the offline hashing embedder otherwise; `real`/`hash` force
  a mode (`CONTEXT_EMBED_MODEL` overrides the model). The test suite pins `hash` via a bunfig
  preload so it stays fast and never downloads a model. A DB is tied to one embedder's vector
  space - reindex if you switch modes.
- **`chitta install` - universal connectors.** One command wires Chitta into 15 AI tools as
  an MCP server (everywhere) and a Skill (where supported): Claude Code, Claude Desktop,
  Cursor, VS Code/Copilot, Windsurf, Zed, Cline, Roo, Codex, Gemini CLI, opencode, Kiro, Amp,
  Factory Droid, Kilo. Per-format writers merge idempotently into existing config; `--print`
  covers any other MCP client. New `src/bin.ts` dispatcher (server / install / cli),
  `src/install/*`, `assets/skill/SKILL.md`. Published to npm as `@100xprompt/chitta` and run
  via `bunx` (the Bun runtime ships SQLite + the vector index in-process - no native build
  step or signed binary needed; macOS 26 kills unsigned compiled binaries, so the bun-compile
  distribution was dropped in favor of source-on-bunx).
- `ARCHITECTURE.md` - pipeline diagram, module-responsibility tables, the security
  invariant, and an "Adding a new backend" guide.
- `examples/permission-aware-retrieval/` - a complete, runnable demo of two users sharing
  one store with per-user visibility.
- `examples/token-reduction/` - a reproducible benchmark (committed corpus + harness +
  generated report) showing ~7.4× token reduction vs dumping the whole knowledge base,
  plus a source-level ACL leak check.
- `SECURITY.md`, `CONTRIBUTING.md`, this changelog, and GitHub issue/PR templates.
- CI workflow (`bun test` + typecheck) on push and PR.
- MIT `LICENSE`.
- README translations in 21 languages under `docs/translations/`, with a language picker
  at the top of the README (zh-CN, zh-TW, ja, ko, hi, bn, es, fr, de, pt-BR, ru, ar, fa,
  it, tr, vi, id, pl, uk, nl, th).

### Changed
- Tests moved from `src/**` into a parallel `test/` tree mirroring the source layout; the
  `test` script now targets `test/`.
