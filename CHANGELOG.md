# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
semantic versioning once it reaches 1.0.

## [Unreleased]

### Fixed
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
