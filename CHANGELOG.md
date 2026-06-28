# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
semantic versioning once it reaches 1.0.

## [Unreleased]

### Security
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
- **`chitta install` - universal connectors.** One command wires Chitta into 15 AI tools as
  an MCP server (everywhere) and a Skill (where supported): Claude Code, Claude Desktop,
  Cursor, VS Code/Copilot, Windsurf, Zed, Cline, Roo, Codex, Gemini CLI, opencode, Kiro, Amp,
  Factory Droid, Kilo. Per-format writers merge idempotently into existing config; `--print`
  covers any other MCP client. New `src/bin.ts` dispatcher (server / install / cli),
  `src/install/*`, `assets/skill/SKILL.md`. npx distribution via a Node shim + per-platform
  bun-compiled binaries (`npm/shim.cjs`, `tools/build-binaries.ts`).
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
