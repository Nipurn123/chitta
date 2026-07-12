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
  <img src="https://img.shields.io/badge/tests-270%20passing-brightgreen" alt="Tests"/>
  <img src="https://img.shields.io/badge/runtime-Bun-black?logo=bun" alt="Bun"/>
  <img src="https://img.shields.io/badge/protocol-MCP-blue" alt="MCP"/>
</p>

<p align="center">
  <a href="docs/assets/chitta-graph.mp4"><img src="docs/assets/chitta-graph.gif" width="640" alt="Chitta knowledge graph - a rotating 3D constellation of concepts, colored by type and linked by relationships"/></a>
</p>
<p align="center"><sub>A real Chitta knowledge graph - 285 concepts, 291 relationships, colored by type, labeled hubs. <a href="docs/assets/chitta-graph.mp4">▶ full-quality MP4</a></sub></p>

***Chitta*** (चित्त) - in Indian philosophy, the mind's storehouse where every impression is
kept. Permission-aware **memory for AI agents**, by **[100xprompt](https://github.com/Nipurn123)**.

Permission-aware **knowledge graph + vector memory** — usable as a standalone **MCP server** *or*
an embeddable **SDK**. Any MCP client (Claude Code, 100xprompt, Claude Desktop, Cursor, IDEs) uses
it via config; any Bun app uses it as a library.

```ts
import { Chitta } from "@100xprompt/chitta"
const memory = new Chitta({ path: "./memory.db" })
await memory.remember("Sarah works at Meta.", { relations: [{ from: "Sarah", to: "Meta", type: "works_at" }] })
await memory.recall("where does Sarah work?")     // hybrid, reranked, ACL-filtered — zero LLM tokens
```

**→ Full SDK guide: [docs/SDK.md](docs/SDK.md)** (multi-tenant ACL, typed graph, self-correction, temporal, scaling flags).

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

**Configure at install time** (every flag is baked into the tool's MCP `env` block, so it
works the same across all tools):

```bash
bunx @100xprompt/chitta install --platform claude-code \
  --user-id alice --org-id acme --role editor --groups eng,sec \
  --embeddings real --memory-ttl 30 --audit          # identity, ACL, real embeddings, TTL, audit log
bunx @100xprompt/chitta install --db-key "$KEY"      # encryption at rest (also: bun add libsql)
```

Flags: `--user-id --org-id --role --groups` (identity/ACL) · `--db <path>` ·
`--embeddings auto|real|hash --embed-model` · `--db-key` (encryption) · `--audit`
(tamper-evident log) · `--memory-ttl <days>` · `--llm-url --llm-model` · `--topk --rerank 0`.
Other: `--project` (project-scoped) · `--list` · `uninstall`.

**Check your setup any time:**

```bash
bunx @100xprompt/chitta doctor   # identity, storage, encryption, ANN, audit, embeddings, counts
```

**Optional extras** (kept out of the default install so `bunx` stays lightweight — the core
runs great with the built-in fast hashing embedder):
- Real semantic embeddings: `bun add @huggingface/transformers` then set `CONTEXT_EMBEDDINGS=real`
  (the default `auto` already uses them when present, else falls back to hashing).
- Encryption at rest: `bun add libsql` then set `CONTEXT_DB_KEY=<key>` (transparent AES whole-file).

**Supported tools (17):** Claude Code, Claude Desktop, Cursor, VS Code (Copilot), Windsurf,
Zed, Cline, Roo Code, Codex CLI, Gemini CLI, opencode, Continue.dev, Goose, Kiro, Amp,
Factory Droid, Kilo Code.
Skill (not just MCP) is installed for the ones that support it (Claude Code, Cursor, Gemini,
opencode, Kiro, Amp, Factory, Kilo, Trae). Any other MCP client: `--print` and paste.

> Published to npm as `@100xprompt/chitta` and run via `bunx` (the Bun runtime ships SQLite +
> the vector index in-process, so there are no native build steps for users).

## Tools exposed over MCP

| Tool | Does |
|---|---|
| `context_ingest` | Store text → record node + **permission edges** (ACL) + **vector chunks** + **canonical concept graph** + **atomic memories** (semantic facts, **episodic** experiences, **procedural** how-tos) |
| `get_context` | Retrieve ranked, cited, permission-filtered snippets + the **current memory** (contradiction-resolved) + relevant experiences + applicable preferences |
| `context_forget` | Forget memories that are no longer true/wanted (soft-delete, within what you may see) |
| `context_profile` | Synthesize a profile of a person/org/entity (permanent + recent facts + connections) |
| `context_graph` | Return the knowledge graph (concepts + relationships) the user can access |
| `context_relate` | Graph queries over the entity graph (neighbors / path / impact / central / communities) |
| `context_timeline` | **Reason over time** — how a subject evolved, or the facts believed **as of** a past date |
| `context_reflect` | **Reflect** — synthesize higher-order insight (recurring focus, what changed, preferences, recent activity) |

## Operate (CLI)

```bash
chitta doctor                      # config + health: identity, encryption, ANN, audit, counts
chitta sleep                       # sleep-time consolidation: dedupe entities, retire expired, re-weight
chitta bench synthetic             # measure memory quality (retrieval + end-to-end QA) - see docs/BENCHMARKING.md

# audit log (enable with CHITTA_AUDIT=1)
chitta audit                       # recent entries (who/what/when)
chitta audit --verify              # check the hash chain is intact (tamper-evident)

# encryption key rotation — the CURRENT key comes from CONTEXT_DB_KEY (not a flag)
chitta rekey --new-key "<key>"                 # encrypt a plaintext store
CONTEXT_DB_KEY="old" chitta rekey --new-key "new"   # rotate to a new key
CONTEXT_DB_KEY="key" chitta rekey --new-key ""      # decrypt back to plaintext
```

Encryption + rotation need the optional driver once: `bun add libsql`.

## Living memory (permission-aware)

Beyond storing snippets, Chitta maintains a **living-memory layer with a real cognitive
model** - the part most memory products treat as proprietary magic, here done natively and
**ACL-scoped**:

- **Canonical graph (coreference)** - "Sarah", "Sarah Chen" and "Ms. Chen" fold into one
  entity, so the graph doesn't fragment and a contradiction stated under a *different surface
  form* still resolves.
- **A memory typology, not just chunks** - **semantic** facts ("Sarah works at Meta"),
  **episodic** experiences (time-anchored events with actors, recalled by relevance × recency),
  and **procedural** how-tos/preferences (trigger → action).
- **Self-correcting** - contradictions supersede (`works_at`: Google → Meta; history kept);
  belief revision is **confidence-aware** (a weak claim can't overwrite a confident one);
  **semantic contradictions** are caught beyond single-valued facts (`likes` vs `dislikes`);
  importance is scored at write; a **sleep-time pass** (`chitta sleep`) dedupes, retires, and
  re-weights by corroboration.
- **Reasons over time** - `context_timeline`: how a subject evolved, or the facts believed
  **as of** a past date (the store is bi-temporal).
- **Reflects** - `context_reflect`: synthesizes higher-order insight (recurring focus, what
  changed, preferences, recent activity) over what you're permitted to see.
- **Forgetting** - `context_forget` soft-deletes by description; optional TTL
  (`CONTEXT_MEMORY_TTL_DAYS`) retires dynamic memories, static facts are exempt. Coherent:
  the underlying graph fact is expired too.
- **Permission-aware throughout** - you can only recall, reflect on, or forget what your ACL
  permits, across a *shared* org graph. (Most memory layers only isolate per-user pools - they
  have no concept of "who is allowed to remember what" inside a team.)

## Run it

```bash
bun install
bun start                         # boots the MCP server (stdio)
bun test                          # 270 tests
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
- `chunks` - text + embedding vectors (Float32 BLOB)
- `vec_chunks` / `vec_native` - **ANN index** (sqlite-vec when plaintext, libSQL native DiskANN when encrypted)

## Vector search - adaptive + fast (in-process)

Three paths, same interface, picked automatically (`store.annEnabled` reflects which is live):

- **Plaintext, extension-capable SQLite →** loads **[sqlite-vec](https://github.com/asg017/sqlite-vec)**
  (`vec0`, in the same file).
- **Encrypted (`CONTEXT_DB_KEY`) →** libSQL **native DiskANN** vector index
  (`F32_BLOB` + `libsql_vector_idx` + `vector_top_k`) - real ANN *inside the encrypted file*,
  no extension to load. Encryption no longer costs you ANN.
- **Fallback (no index available) →** fast brute-force cosine in TS.

The brute-force path is engineered for low latency: embeddings are stored as compact
**Float32 BLOBs** (no `JSON.parse` per query - decoded zero-copy), scored by **dot product**
(== cosine for normalized vectors), kept with a **bounded top-k** selector (no full sort).
Measured ~1.4 ms @1k and ~15 ms @10k vectors; the ANN paths stay sub-ms well beyond that.
Read pragmas (256 MB page cache, mmap on plaintext, WAL) keep steady-state queries hot.

## Benchmarks & performance

All numbers **measured this release** on a dev laptop (hash embedder unless noted; ratios, not SLAs). Full detail + caveats in [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

### Retrieval quality — at **zero LLM tokens**

| Benchmark | Metric | Chitta | Notes |
|---|---|--:|---|
| **LongMemEval** | recall@10 (Tier-A) | **0.782** | session-level evidence |
| **LoCoMo** | recall@10 (Tier-A) | **0.525** | 1,986 Q · `bge-small` · rerank on (default) |
| **LoCoMo** | nDCG@10 / MRR | 0.414 / 0.407 | single-hop **0.61** · reranker +22% / +36% |
| **LoCoMo** | context reduction | **151×** | 171 vs 25,864 tokens/question |

Retrieval is fully **LLM-free** and hands the reader **171 tokens instead of 25,864** (151× less). Competitors post 90%+ on *end-to-end QA* (an LLM reads the memory and answers) — e.g. Mem0 at **~6,900 tokens/query**; Chitta spends **0**. Compare accuracy *at token cost*. Note: LoCoMo/LongMemEval are casual conversation, where Chitta's zero-token typed extraction is starved (few relations to extract) — its graph cognition shines on fact-dense data; see [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

### Graph retrieval — **O(1) in graph size**

```
query latency @100K-record graph        (lower is better)
bounded   O(1)   ▏ 0.05 ms
unbounded O(N)   ████████████████████████████████████████ 2.0 ms  →  39× slower, and widening
```
Flat ~0.05 ms from 50K→100K; recall held (+0.6% vs unbounded). `CONTEXT_GRAPH_BOUNDED` (default on).

### Ingest — **O(N²) → ~O(N log N)**

```
per-record ingest @8K records            (lower is better)
before  O(N²)     ████████████████████████████████████████ 25.7 ms   (20K used to time out)
now   ~O(N log N) ██ 1.14 ms                                          ≈ 22× faster
```

| records | before (O(N²)) | now (~O(N log N)) |
|--:|--:|--:|
| 1K | 2.25 ms/rec | 0.60 ms/rec |
| 8K | 25.7 ms/rec | 1.14 ms/rec |
| 16K | *(timed out)* | 1.72 ms/rec |

### Dense vector — sub-linear both ways

```
dense ANN query @100K vectors            (lower is better)
vec0 (default)    ████████████████████████████████████████ 51 ms
DiskANN (opt-in)  ██████ ~8 ms                                        ≈ 6× faster, flat
```

| corpus | vec0 (default) | DiskANN (`CONTEXT_DISKANN=1`) |
|--:|--:|--:|
| 3K | 1.6 ms | 8.4 ms |
| 18K | 9.7 ms | 8.1 ms |
| 100K | 51 ms | ~8 ms |

- **Filtered-ANN** (default, scoped users): dense search is **O(accessible), not O(corpus)** — leak-proof by construction, exact (**Δrecall = 0**), ~4.6× faster for a scoped user at a 12K corpus.
- **DiskANN** is opt-in for *large, read-heavy* corpora: sub-linear query (0.98 recall vs exact), but ~80× slower ingest and an ~8 ms floor — vec0 wins below ~15–18K.

## Status

Implemented: ACL graph, vector store, retrieval + leak guard, **knowledge-graph extraction**, MCP server
(local + central), fetch-based Arango/Qdrant/embedding adapters. All dependency-free except the MCP SDK.

Next (swap-in, same interfaces): real embeddings (transformers.js ONNX `bge-*`) for semantic ranking;
GraphRAG retrieval (expand results along `relates_to` edges); LLM-based entity extraction for higher recall.

See [ARCHITECTURE.md](ARCHITECTURE.md) for module-by-module internals and the security invariant.

## Docs

- [ARCHITECTURE.md](ARCHITECTURE.md) - pipeline, module map, security invariant, extending it
- [docs/BENCHMARKING.md](docs/BENCHMARKING.md) - measure memory quality (Tier A retrieval + Tier B end-to-end QA; LongMemEval/LoCoMo)
- [docs/SDK.md](docs/SDK.md) - the embeddable SDK: quickstart, multi-tenant ACL, typed graph, self-correction, temporal
- [docs/API.md](docs/API.md) - complete SDK API reference: Chitta / ChittaUser, every option + return type, errors, onEvent, chittaTools
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) - production deployment: persistence, encryption at rest, scaling flags, multi-tenant ACL, checklist
- [docs/PERFORMANCE.md](docs/PERFORMANCE.md) - why it scales: measured graph / ingest / filtered-ANN / DiskANN numbers, with honest caveats
- [docs/adapters.md](docs/adapters.md) - use Chitta as tools in the Vercel AI SDK / OpenAI / Anthropic agent loops, or as a LangChain retriever / memory
- [docs/RELEASING.md](docs/RELEASING.md) - how to cut a release: version bump, CHANGELOG, git tag + GitHub Release → bun publish
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
