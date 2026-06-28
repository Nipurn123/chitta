# Chitta

<!-- LANG-PICKER-START -->
<p align="center">
  <b>English</b> ·
  <a href="docs/translations/README.zh-CN.md">简体中文</a> ·
  <a href="docs/translations/README.zh-TW.md">繁體中文</a> ·
  <a href="docs/translations/README.ja-JP.md">日本語</a> ·
  <a href="docs/translations/README.ko-KR.md">한국어</a> ·
  <a href="docs/translations/README.hi-IN.md">हिन्दी</a> ·
  <a href="docs/translations/README.bn-IN.md">বাংলা</a> ·
  <a href="docs/translations/README.es-ES.md">Español</a> ·
  <a href="docs/translations/README.fr-FR.md">Français</a> ·
  <a href="docs/translations/README.de-DE.md">Deutsch</a> ·
  <a href="docs/translations/README.pt-BR.md">Português</a> ·
  <a href="docs/translations/README.ru-RU.md">Русский</a> ·
  <a href="docs/translations/README.ar-SA.md">العربية</a> ·
  <a href="docs/translations/README.fa-IR.md">فارسی</a> ·
  <a href="docs/translations/README.it-IT.md">Italiano</a> ·
  <a href="docs/translations/README.tr-TR.md">Türkçe</a> ·
  <a href="docs/translations/README.vi-VN.md">Tiếng Việt</a> ·
  <a href="docs/translations/README.id-ID.md">Bahasa Indonesia</a> ·
  <a href="docs/translations/README.pl-PL.md">Polski</a> ·
  <a href="docs/translations/README.uk-UA.md">Українська</a> ·
  <a href="docs/translations/README.nl-NL.md">Nederlands</a> ·
  <a href="docs/translations/README.th-TH.md">ภาษาไทย</a>
</p>
<!-- LANG-PICKER-END -->

<p>
  <a href="https://www.npmjs.com/package/@100xprompt/chitta"><img src="https://img.shields.io/npm/v/@100xprompt/chitta?color=cb3837&logo=npm" alt="npm"/></a>
  <a href="https://github.com/Nipurn123/chitta/actions/workflows/ci.yml"><img src="https://github.com/Nipurn123/chitta/actions/workflows/ci.yml/badge.svg" alt="CI"/></a>
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"/>
  <img src="https://img.shields.io/badge/tests-139%20passing-brightgreen" alt="Tests"/>
  <img src="https://img.shields.io/badge/runtime-Bun-black?logo=bun" alt="Bun"/>
  <img src="https://img.shields.io/badge/protocol-MCP-blue" alt="MCP"/>
</p>

<p align="center">
  <a href="docs/assets/chitta-graph.mp4"><img src="docs/assets/chitta-graph.gif" width="640" alt="Chitta knowledge graph - a rotating 3D constellation of concepts, colored by type and linked by relationships"/></a>
</p>
<p align="center"><sub>A real Chitta knowledge graph - 285 concepts, 291 relationships, colored by type, labeled hubs. <a href="docs/assets/chitta-graph.mp4">▶ full-quality MP4</a></sub></p>

***Chitta*** (चित्त) - in Indian philosophy, the mind's storehouse where every impression is
kept. Permission-aware **memory for AI agents**, by **[100xprompt](https://github.com/Nipurn123)**.

Permission-aware **knowledge graph + vector memory**, shipped as a standalone **MCP server**.
Any MCP client (Claude Code, 100xprompt, Claude Desktop, Cursor, IDEs) uses it via config - no code changes.

Point your AI assistant at it once, and every conversation can **store, recall, and reason over**
your team's knowledge - with each user seeing only what their permissions allow.

> The part every other memory layer treats as an afterthought: who is allowed to remember what.

> **Architecture & internals:** see [ARCHITECTURE.md](ARCHITECTURE.md).

- **Local mode (default):** one SQLite file. Ingest, extract a knowledge graph, retrieve - no servers.
- **Central-office mode:** point it at a shared backend (ArangoDB + Qdrant + embeddings) via env; the
  whole org shares one graph, each user sees only what their ACL permits.

## See it in 30 seconds

Two users, one store, three documents - each user sees only what they're allowed to:

```bash
bun install
./examples/permission-aware-retrieval/run.sh
```

```
ALICE (org handbook + her roadmap; NOT comp):
  • [Company Handbook]  Acme builds privacy-first AI infrastructure…
  • [Eng Roadmap]       Q3 roadmap: ship the permission-aware retrieval engine…

BOB (org handbook + his comp; NOT roadmap):
  • [Company Handbook]  Acme builds privacy-first AI infrastructure…
  • [Comp Bands]        Compensation bands for 2026. Senior engineers: 180-220k…
```

Same query, different results - because the ACL graph produces the candidate set *before*
the vector index is touched. Full walkthrough: [examples/permission-aware-retrieval](examples/permission-aware-retrieval/).

**Benchmark:** on a small permission-scoped knowledge base, retrieval delivers
**7.4× fewer tokens** than dumping the whole corpus into context (more as the corpus
grows) - with **zero cross-user leak**. Reproducible: [examples/token-reduction](examples/token-reduction/).

## Install

Chitta runs on [Bun](https://bun.sh) (install once: `curl -fsSL https://bun.sh/install | bash`).
One command then wires it into your AI tools - as an **MCP server** (everywhere) and a
**Skill** (where supported):

```bash
bunx @100xprompt/chitta install                 # auto-detect installed tools
bunx @100xprompt/chitta install --all           # every supported tool
bunx @100xprompt/chitta install --platform cursor,claude-code
bunx @100xprompt/chitta install --print         # just print the MCP config to paste anywhere
```

Options: `--project` (write project-scoped config instead of global) · `--user-id <id> --org-id <id>`
(bake identity into the config) · `--list` (show all tools) · `uninstall`.

**Optional extras** (kept out of the default install so `bunx` stays lightweight — the core
runs great with the built-in fast hashing embedder):
- Real semantic embeddings: `bun add @huggingface/transformers` then set `CONTEXT_EMBEDDINGS=real`
  (the default `auto` already uses them when present, else falls back to hashing).
- Encryption at rest: `bun add libsql` then set `CONTEXT_DB_KEY=<key>` (transparent AES whole-file).

**Supported tools (15):** Claude Code, Claude Desktop, Cursor, VS Code (Copilot), Windsurf,
Zed, Cline, Roo Code, Codex CLI, Gemini CLI, opencode, Kiro, Amp, Factory Droid, Kilo Code.
Skill (not just MCP) is installed for the ones that support it (Claude Code, Cursor, Gemini,
opencode, Kiro, Amp, Factory, Kilo, Trae). Any other MCP client: `--print` and paste.

> Published to npm as `@100xprompt/chitta` and run via `bunx` (the Bun runtime ships SQLite +
> the vector index in-process, so there are no native build steps for users).

## Tools exposed over MCP

| Tool | Does |
|---|---|
| `context_ingest` | Store text → record node + **permission edges** (ACL) + **vector chunks** + **extracted concept graph** + **atomic memories** |
| `get_context` | Retrieve ranked, cited, permission-filtered snippets + the **current memory** (latest, contradiction-resolved) |
| `context_forget` | Forget memories that are no longer true/wanted (soft-delete, within what you may see) |
| `context_graph` | Return the knowledge graph (concepts + relationships) the user can access |
| `context_relate` | Graph queries over the entity graph (neighbors / path / impact / central) |

## Living memory (permission-aware)

Beyond storing snippets, Chitta maintains a **living-memory layer** - the part most memory
products treat as proprietary magic, here done natively and **ACL-scoped**:

- **Atomic memories** - precise typed facts ("Sarah works at Meta"), not just chunks.
- **Contradiction → versioning** - a newer single-valued fact **supersedes** the old one
  (`works_at`: Google → Meta); recall returns the current truth, history is kept (v1→vN).
- **Forgetting** - `context_forget` soft-deletes by description; optional TTL
  (`CONTEXT_MEMORY_TTL_DAYS`) retires dynamic memories, static facts are exempt. It's
  coherent: the underlying graph fact is expired too.
- **Permission-aware throughout** - you can only recall or forget what your ACL permits,
  across a *shared* org graph. (Most memory layers only isolate per-user pools - they have
  no concept of "who is allowed to remember what" inside a team.)

## Run it

```bash
bun install
bun start                         # boots the MCP server (stdio)
bun test                          # 139 tests
bun run build                     # → dist/chitta (single binary)
```

## Use it from any MCP client

```jsonc
{
  "mcp": {
    "context": {
      "type": "local",
      "command": ["bun", "run", "/path/to/chitta/src/mcp/server.ts"],
      "environment": { "CONTEXT_USER_ID": "alice", "CONTEXT_ORG_ID": "acme" }
    }
  }
}
```

**Central office:** add the shared backend URLs so everyone queries one graph with per-user ACL:

```jsonc
"environment": {
  "CONTEXT_USER_ID": "alice", "CONTEXT_ORG_ID": "acme",
  "CONTEXT_ARANGO_URL": "https://office.internal/arango",
  "CONTEXT_QDRANT_URL": "https://office.internal/qdrant",
  "CONTEXT_EMBED_URL": "https://office.internal/embed",
  "CONTEXT_COLLECTION": "records"
}
```

## How it works

```
ingest → record node + permission edges (ACL)      ┐
       → chunk + embed → vectors                    ├─ all in one SQLite file (local)
       → extract entities + relations → graph       ┘
query  → ACL: which records may this user see?  (graph traversal)
       → vector search restricted to those records
       → cross-connector leak guard → cited snippets
```

## Storage (local mode)

One file at `$CONTEXT_DB` or `~/.local/share/100xprompt/context.db`:
- `nodes` - graph vertices (records, users, orgs, **entities**)
- `edges` - relationships (`permissions`, `belongsTo`, `mentions`, `relates_to`)
- `chunks` - text + embedding vectors
- `vec_chunks` - **sqlite-vec ANN index** (when available - see below)

## Vector search - adaptive (sqlite-vec, in-process)

If an extension-capable SQLite is present, the store loads **[sqlite-vec](https://github.com/asg017/sqlite-vec)**
and keeps a `vec0` ANN index *in the same file* - the TS-native, Python-free equivalent of
zvec ("the SQLite of vector DBs"). ~16× faster than brute-force at 3k vectors, more at scale.
Otherwise it **transparently falls back to brute-force cosine** - same results, same interface,
fully portable for the single-binary path.

`bun:sqlite` disables extension loading by default; to enable the ANN fast path, point it at an
extension-capable SQLite (e.g. `brew install sqlite`, auto-detected at common paths). No config
needed - `store.vecEnabled` reflects which path is active.

## Status

Implemented: ACL graph, vector store, retrieval + leak guard, **knowledge-graph extraction**, MCP server
(local + central), fetch-based Arango/Qdrant/embedding adapters. All dependency-free except the MCP SDK.

Next (swap-in, same interfaces): real embeddings (transformers.js ONNX `bge-*`) for semantic ranking;
GraphRAG retrieval (expand results along `relates_to` edges); LLM-based entity extraction for higher recall.

See [ARCHITECTURE.md](ARCHITECTURE.md) for module-by-module internals and the security invariant.

## Docs

- [ARCHITECTURE.md](ARCHITECTURE.md) - pipeline, module map, security invariant, extending it
- [examples/](examples/) - runnable demos
- [CONTRIBUTING.md](CONTRIBUTING.md) - dev setup and workflow
- [SECURITY.md](SECURITY.md) - security model and how to report issues
- [CHANGELOG.md](CHANGELOG.md) - notable changes

## Star history

<a href="https://star-history.com/#Nipurn123/chitta&Date">
  <img src="https://api.star-history.com/svg?repos=Nipurn123/chitta&type=Date" alt="Star History Chart" width="600"/>
</a>

## License

[MIT](LICENSE) © 2026 Nipurn Agarwal
