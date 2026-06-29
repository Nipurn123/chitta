# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
semantic versioning once it reaches 1.0.

## [Unreleased]

## [0.1.12] - 2026-06-29

### Docs
- **Accuracy pass on shipped docs.** The skill (`assets/skill/SKILL.md`) and `ARCHITECTURE.md`
  listed only 3 of the 7 MCP tools — updated to include `context_forget`, `context_profile`,
  `context_relate`, `context_about`, with when-to-use guidance. README now documents the
  operational CLI (`chitta doctor`, `chitta audit [--verify]`, `chitta rekey`) with the
  **correct** rekey usage (the current key comes from `CONTEXT_DB_KEY`, not an `--old-key`
  flag). Storage-schema tables now list `memories`, `audit`, and `vec_native`, and note
  embeddings are Float32 BLOBs. Test-count badge refreshed (205). The `install` success
  message lists the full tool set and points to `chitta doctor`.

### Performance
- **~3.9× faster `get_context` via ACL/graph memoization (zero algorithm change).** A single
  `get_context` recomputed the two expensive, side-effect-free provider lookups
  (`getAccessibleVirtualRecordIds`, `getKnowledgeGraph`) up to 4× — once each in KGQA, memory
  recall, neighborhood, and hybrid search — and again on every repeat query. They're now
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
  tests are no longer skipped — they pass, verifying the Tier-2 encrypted-ANN path end to end.
  (It remains an *opt-in runtime* extra for users — `bun add libsql` — and does NOT ship in
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
- **`chitta doctor` — configuration & health at a glance.** Shows the effective setup the
  MCP server runs with: identity/role/groups, storage path, encryption on/off, vector-ANN
  vs brute-force, embeddings mode, reranker, audit on/off (+ chain integrity), memory TTL,
  LLM extraction, and live record/chunk/entity/memory counts — plus actionable warnings
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
  never surfaced — `context_relate(neighbors)` returned them but `get_context` didn't. Now
  when a query **names a known entity**, `get_context` folds in that entity's **complete
  typed neighborhood** (the same full edge set as `context_relate`) as an additive "Related
  facts about X" section. Gated to breadth queries or when KGQA found no precise answer, so a
  narrow factual question stays focused. New `GraphQueryService.neighborsForQuery`
  (free-text → named entity → full neighborhood) + `backend.relatedFacts`. Regressions:
  `test/embedded/graph-query.test.ts`, `test/mcp/get-context.test.ts`.
- **`bunx` launch failure / "server disconnected" + 2.4 GB install.** `@huggingface/transformers`
  (~2.4 GB) and `libsql` were `optionalDependencies`, so `bunx @100xprompt/chitta` tried to
  download them on every launch — failing on tight disks and bloating installs. They're now
  **opt-in extras** (`bun add @huggingface/transformers` / `bun add libsql`); the published
  package installs only the ~55 MB core. The default `auto` embedder uses real embeddings when
  the package is present, else the fast hashing embedder. (Encryption + reranker code unchanged;
  both lazy-import and degrade gracefully when the extra isn't installed.)
- **`get_context` incompleteness (was returning ~20% of relevant context).** Two causes:
  (1) a **KGQA short-circuit** returned only the 1-few exact typed-graph facts and skipped the
  ranked retrieval entirely; (2) the final cut was **`topk=6`**. Now `get_context` is
  **additive** — the precise typed-graph answer is a highlight *on top of* the full ranked
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
- **Hardening bundle — ahead-of-field defenses (`src/security/`):**
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
    (CTLR==0), identity-not-query injection invariance, deny-by-default — runs in CI.
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
  libSQL with whole-file AES-256 encryption — the `.db` is ciphertext on disk; graph, ACL,
  FTS, and vector search keep working. Default (no key) stays plain `bun:sqlite` with the ANN
  index, untouched. Trade-off: the encrypted driver can't load `sqlite-vec`, so encrypted
  mode uses brute-force cosine (no ANN speedup). New `src/embedded/store/db.ts` driver
  abstraction; `libsql` optional dependency; `test/security/encryption.test.ts` proves
  plaintext never hits disk. (Required a one-line validated-literal `vec0` write to dodge a
  libSQL bound-param panic — confined to the encrypted path.)
- **Real semantic embeddings by default.** `buildEmbeddedContext` now selects embeddings via
  `CONTEXT_EMBEDDINGS` (default `auto`): real transformers.js embeddings (`bge-*`) when
  loadable, automatic fallback to the offline hashing embedder otherwise; `real`/`hash` force
  a mode (`CONTEXT_EMBED_MODEL` overrides the model). The test suite pins `hash` via a bunfig
  preload so it stays fast and never downloads a model. A DB is tied to one embedder's vector
  space — reindex if you switch modes.
- **`chitta install` - universal connectors.** One command wires Chitta into 15 AI tools as
  an MCP server (everywhere) and a Skill (where supported): Claude Code, Claude Desktop,
  Cursor, VS Code/Copilot, Windsurf, Zed, Cline, Roo, Codex, Gemini CLI, opencode, Kiro, Amp,
  Factory Droid, Kilo. Per-format writers merge idempotently into existing config; `--print`
  covers any other MCP client. New `src/bin.ts` dispatcher (server / install / cli),
  `src/install/*`, `assets/skill/SKILL.md`. Published to npm as `@100xprompt/chitta` and run
  via `bunx` (the Bun runtime ships SQLite + the vector index in-process — no native build
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
