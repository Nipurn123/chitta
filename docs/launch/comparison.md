# Chitta vs. mem0 vs. Zep/Graphiti vs. supermemory

An honest, source-cited comparison. Every competitor number below links to where we found it. Where
we couldn't find a published number, the cell says **"Not published"** — we did not estimate, infer,
or guess. Research date: **July 2026**; GitHub star counts move daily and are point-in-time snapshots.

Chitta's own numbers (recall@10, latency) are our own measured, reproducible benchmarks — see
[docs/BENCHMARKING.md](../BENCHMARKING.md). Everything else in this doc is a third-party claim, cited.

## Comparison table

| | **Chitta** | **mem0** | **Zep / Graphiti** | **supermemory** |
|---|---|---|---|---|
| **Local-first (no cloud required)** | Yes — default is one SQLite file, no servers. Self-hosted "central-office" mode (ArangoDB+Qdrant) for teams, still self-hosted. | Partial — OSS core is self-hostable ([Docker guide](https://mem0.ai/blog/self-host-mem0-docker)), but the default pipeline calls a cloud LLM (GPT-4o-mini) for extraction; the primary product is the managed [Mem0 Platform](https://app.mem0.ai) cloud. | No / Partial — **Zep** (the product) is cloud-only; Community Edition was discontinued in 2026 ([announcement](https://blog.getzep.com/announcing-a-new-direction-for-zeps-open-source-strategy/)). **Graphiti** (the underlying graph engine) is self-hostable but [requires an LLM provider](https://github.com/getzep/graphiti) (defaults to OpenAI's cloud API) for both ingestion and retrieval. | Yes — ships a self-hosted local binary that can run fully offline against Ollama ("nothing leaves your machine," per [their own repo](https://github.com/supermemoryai/supermemory)); a hosted cloud API/console is also offered. |
| **Zero-token retrieval** (no LLM call to search/rank/extract) | **Yes** — local embeddings + deterministic extraction + reranker. 0 LLM tokens. | **No** — paper states "all language model operations utilized GPT-4o-mini" for extraction ([arXiv:2504.19413](https://arxiv.org/abs/2504.19413)); published benchmark numbers are end-to-end, LLM-judged QA accuracy, not a token-free retrieval metric. | **No** — Graphiti's own docs state an LLM provider is required for **both ingestion and retrieval** ([github.com/getzep/graphiti](https://github.com/getzep/graphiti)). | **Not clearly published** — ingestion appears to use LLM-based fact/profile extraction ([product blog](https://supermemory.ai/blog/knowledge-graph-solutions-rag-applications)); we found no explicit statement confirming or denying LLM token cost specifically at retrieval time. |
| **Knowledge graph** | Yes — typed entities + relations, ACL-aware. | Yes — optional "Graph Memory" (Mem0ᵍ), Neo4j-backed, LLM-extracted entities/relations ([docs](https://github.com/mem0ai/mem0/discussions/4020), [paper](https://arxiv.org/html/2504.19413v1)). | Yes — this is Graphiti's core design: a temporal knowledge graph ("Context Graph") with validity windows per fact ([github.com/getzep/graphiti](https://github.com/getzep/graphiti)). | Yes, per their own claim: "ships a complete graph RAG stack... graph database, extractors, connectors... in one API" ([supermemory blog](https://supermemory.ai/blog/knowledge-graph-solutions-rag-applications)). |
| **Permission-aware / ACL** (fine-grained, per-record visibility on a *shared* store) | **Yes** — ACL filters the candidate set *before* vector search touches it; two users query the same store and see only what their permissions allow. | **Not published** — has `user_id` / `agent_id` / `run_id` scoping to organize memories; we found no documented fine-grained ACL/permission system. | **Different mechanism** — Zep has account/project-level Role-Based Access Control (who on your team can access the dashboard) ([docs](https://help.getzep.com/role-based-access-control)) and per-user Graph **isolation** (each User has a separate, non-shared User Graph) ([docs](https://help.getzep.com/users)) — not fine-grained visibility control over a single shared graph. | **Different mechanism** — "Multi-User Spaces" and Scoped API Keys restricted to `containerTags` (workspace/project-level scoping) ([docs](https://deepwiki.com/supermemoryai/supermemory/6-api-reference)) — not fine-grained per-record ACL on a shared graph. |
| **Installs into AI coding tools (MCP/skill)** | Yes — MCP server + skill, installs into **17 AI coding tools**. | Yes — official MCP server (cloud-hosted at `mcp.mem0.ai`) for Claude, Claude Code, Cursor, Windsurf, VS Code, OpenCode ([docs.mem0.ai](https://docs.mem0.ai/platform/mem0-mcp)); community self-hosted MCP variants also exist. No published "skill" format found. | Yes — official Graphiti MCP server, reached "1.0" in 2026 ([blog.getzep.com](https://blog.getzep.com/graphiti-hits-20k-stars-mcp-server-1-0/)). No published "skill" format found. | Yes — official MCP server, one-line install (`npx -y install-mcp@latest`) for Claude Desktop, Cursor, Windsurf, VS Code, Claude Code, OpenCode, OpenClaw, Hermes ([github.com/supermemoryai/supermemory](https://github.com/supermemoryai/supermemory)). No published "skill" format found. |
| **License** | MIT | Apache-2.0 (core OSS repo, [LICENSE](https://github.com/mem0ai/mem0/blob/main/LICENSE)); the managed Mem0 Platform is a separate proprietary cloud service. | **Graphiti:** Apache-2.0, actively maintained ([LICENSE](https://github.com/getzep/graphiti/blob/main/LICENSE)). **Zep Community Edition:** technically still Apache-2.0 but discontinued/unmaintained since 2026. **Zep commercial cloud service:** proprietary, closed. | MIT ([LICENSE](https://github.com/supermemoryai/supermemory/blob/main/LICENSE)) |
| **Published LoCoMo** | **0.552** recall@10 (Tier-A) — **zero-token** setting (own benchmark, see [docs/BENCHMARKING.md](../BENCHMARKING.md)) | **66.9%** overall LLM-as-Judge accuracy vs. OpenAI's 52.9% (26% relative uplift), original paper, Apr 2025, GPT-4o-mini in the loop ([arXiv:2504.19413](https://arxiv.org/abs/2504.19413)). A newer, undated Mem0 marketing page separately claims **92.5** with no in-page methodology detail ([mem0.ai/research](https://mem0.ai/research)) — we list both rather than pick the flattering one. | **Not in the peer-reviewed paper** ([arXiv:2501.13956](https://arxiv.org/abs/2501.13956) reports DMR 94.8% and LongMemEval only, no LoCoMo). Zep's LoCoMo number is from a **company blog post**: originally claimed ~84%, self-corrected in place to **75.14% ± 0.17** after Zep wrote "we erred in how we calculated Zep's LoCoMo score" ([blog.getzep.com](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/)). That corrected number is itself publicly disputed by Mem0's co-founder, who calculates **58.44% ± 0.20** ([GitHub issue](https://github.com/getzep/zep-papers/issues/5)). Unresolved as of this writing — see caveats below. | **Not published.** Supermemory's own research page states LoCoMo "was not benchmarked in this report" — they benchmark LongMemEval-S instead ([supermemory.ai/research/longmembench](https://supermemory.ai/research/longmembench/)). |
| **Published LongMemEval** *(bonus row, not requested but relevant)* | **0.782** recall@10 (Tier-A) — zero-token setting (own benchmark) | **94.4** overall, undated marketing page, methodology not detailed in-page ([mem0.ai/research](https://mem0.ai/research)). | Paper reports **relative** gains only: "+18.5% accuracy, -90% latency" vs. baseline, no absolute self-reported score found ([arXiv:2501.13956](https://arxiv.org/abs/2501.13956)). | **95%** overall (Recall@15, LongMemEval-S, GPT-4o-as-judge) — supermemory's own self-reported number ([supermemory.ai/research/longmembench](https://supermemory.ai/research/longmembench/)). Same page separately reports supermemory's own measurement of **Zep at 71.2%** on the same test — that is supermemory's third-party measurement of Zep, not Zep's self-report. |
| **GitHub stars** *(point-in-time, July 2026)* | Pre-launch — repo not yet public. This document is part of that launch. | **~60.7k** ([github.com/mem0ai/mem0](https://github.com/mem0ai/mem0)) | **Graphiti: ~28.6k** ([github.com/getzep/graphiti](https://github.com/getzep/graphiti)). Zep's examples/SDK repo (not the product): ~4.7k ([github.com/getzep/zep](https://github.com/getzep/zep)). | **~28.3k** ([github.com/supermemoryai/supermemory](https://github.com/supermemoryai/supermemory)) |

## How we measured / caveats

**The zero-token vs. with-LLM distinction is the single most important thing in this document.**
Chitta's `0.552` (LoCoMo) and `0.782` (LongMemEval) are **recall@10** numbers: how often the right
evidence is in the top 10 retrieved chunks, measured with **zero LLM calls** anywhere in the retrieval
path (local embeddings, deterministic extraction, a local reranker). mem0, Zep, and supermemory's
published numbers above are **end-to-end, LLM-judged QA accuracy**: their pipeline retrieves memory,
hands it to an LLM (typically GPT-4o or GPT-4o-mini) to *answer* the benchmark question, and then a
second LLM *judges* whether that answer was correct. These are different metrics measuring different
things — a recall score and an LLM-graded answer-accuracy score are not on the same scale, and a
higher-looking percentage on one is not "beating" a lower-looking recall number on the other. We are
not aware of any competitor that has published a zero-token / LLM-free recall number on LoCoMo or
LongMemEval that would be directly comparable to Chitta's; if one exists, it isn't findable in what we
searched, so it isn't in this table.

**On mem0's two different LoCoMo numbers.** mem0's original paper (arXiv:2504.19413, April 2025)
reports 66.9% LLM-as-Judge accuracy using GPT-4o-mini for extraction. A separate, undated page on
mem0.ai/research claims 92.5 with no stated methodology, model, or category breakdown on that page.
We list both because picking only the higher, less-documented number would be exactly the kind of
cherry-picking this document is trying to avoid.

**On the Zep LoCoMo dispute.** Zep's LoCoMo score has been revised twice in public: ~84% (initial blog
claim) → 75.14% ± 0.17 (Zep's own in-place correction, after acknowledging a calculation error) →
58.44% ± 0.20 (a further correction claimed by Mem0's co-founder, alleging a category-inclusion error
in Zep's methodology, which Zep has in turn disputed). We report Zep's own current published figure
(75.14%) in the table and flag it as contested rather than silently picking a side. Notably, the number
does not appear in Zep/Graphiti's peer-reviewed arXiv paper at all — only in a company blog post — so
"published in their paper" (mem0) and "published in a blog post" (Zep) are not quite the same
evidentiary weight, and we've kept that distinction explicit rather than blurring the two into one
"competitor published X%" line.

**On permission-awareness.** All three competitors have *some* access-control concept, but none of what
we found is the same feature as Chitta's ACL: Zep offers team/dashboard RBAC (who can manage the
account) plus per-user graph **isolation** (separate graphs per user, not a shared graph with filtered
visibility); supermemory offers workspace/API-key scoping by container tag; mem0 offers only
memory-organization scoping (`user_id`/`agent_id`/`run_id`), not a permission system. Chitta's
differentiator is that **one shared graph** can be queried by multiple users/agents and each sees only
the subset their permissions allow, filtered before the vector index is touched. We did not find a
directly equivalent feature in any of the three competitors, but we also did not find any of them
claiming to have one — this is a feature-shape difference, not a case of a competitor's feature being
inferior at the same job.

**On "local-first."** Graphiti (the open-source graph engine behind Zep) is self-hostable, but its own
documentation states it requires an LLM provider (OpenAI by default) for both ingestion and retrieval —
so "self-hostable" and "cloud-free" are not the same claim, and we've represented both dimensions
separately rather than collapsing them into a single yes/no. Zep the product no longer offers a
supported self-hosted path at all as of the Community Edition discontinuation. mem0's OSS core is
self-hostable, but its default configuration and headline benchmark numbers depend on a cloud LLM
call for memory extraction. supermemory is the only one of the three with an explicit, vendor-stated
fully-offline local mode (pointed at Ollama).

**On GitHub stars.** These are a popularity/adoption signal, not a quality signal, and they change
daily — treat the numbers above as a July 2026 snapshot, not a live figure. Chitta's own repository is
not yet public; this comparison document is part of the launch that will change that.

## Sources

- mem0 — repository, license, stars: [github.com/mem0ai/mem0](https://github.com/mem0ai/mem0), [LICENSE](https://github.com/mem0ai/mem0/blob/main/LICENSE)
- mem0 — paper: ["Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory," arXiv:2504.19413](https://arxiv.org/abs/2504.19413) (full text: [arxiv.org/html/2504.19413v1](https://arxiv.org/html/2504.19413v1))
- mem0 — current marketing benchmarks page: [mem0.ai/research](https://mem0.ai/research)
- mem0 — self-hosting guide: [mem0.ai/blog/self-host-mem0-docker](https://mem0.ai/blog/self-host-mem0-docker)
- mem0 — MCP docs: [docs.mem0.ai/platform/mem0-mcp](https://docs.mem0.ai/platform/mem0-mcp), [mem0.ai/blog/introducing-openmemory-mcp](https://mem0.ai/blog/introducing-openmemory-mcp)
- mem0 — graph memory: [github.com/mem0ai/mem0/discussions/4020](https://github.com/mem0ai/mem0/discussions/4020)
- mem0 — dispute of Zep's LoCoMo number (opened by Mem0 co-founder/CTO Deshraj Yadav): [github.com/getzep/zep-papers/issues/5](https://github.com/getzep/zep-papers/issues/5)
- Zep/Graphiti — repository, license, stars: [github.com/getzep/graphiti](https://github.com/getzep/graphiti), [LICENSE](https://github.com/getzep/graphiti/blob/main/LICENSE)
- Zep — examples/SDK repository: [github.com/getzep/zep](https://github.com/getzep/zep)
- Zep — paper: ["Zep: A Temporal Knowledge Graph Architecture for Agent Memory," arXiv:2501.13956](https://arxiv.org/abs/2501.13956)
- Zep — open-source strategy change / Community Edition discontinuation: [blog.getzep.com/announcing-a-new-direction-for-zeps-open-source-strategy](https://blog.getzep.com/announcing-a-new-direction-for-zeps-open-source-strategy/)
- Zep — MCP Server 1.0 / stars announcement: [blog.getzep.com/graphiti-hits-20k-stars-mcp-server-1-0](https://blog.getzep.com/graphiti-hits-20k-stars-mcp-server-1-0/)
- Zep — rebuttal of Mem0's benchmark claims (contains Zep's corrected 75.14% LoCoMo figure): [blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/)
- Zep — RBAC docs: [help.getzep.com/role-based-access-control](https://help.getzep.com/role-based-access-control)
- Zep — Users/graph isolation docs: [help.getzep.com/users](https://help.getzep.com/users)
- supermemory — repository, license, stars: [github.com/supermemoryai/supermemory](https://github.com/supermemoryai/supermemory), [LICENSE](https://github.com/supermemoryai/supermemory/blob/main/LICENSE)
- supermemory — benchmark research page (LongMemEval-S, explicitly states LoCoMo not benchmarked): [supermemory.ai/research/longmembench](https://supermemory.ai/research/longmembench/)
- supermemory — research index: [supermemory.ai/research](https://supermemory.ai/research)
- supermemory — knowledge graph claim: [supermemory.ai/blog/knowledge-graph-solutions-rag-applications](https://supermemory.ai/blog/knowledge-graph-solutions-rag-applications)
- supermemory — API/access-control reference: [deepwiki.com/supermemoryai/supermemory/6-api-reference](https://deepwiki.com/supermemoryai/supermemory/6-api-reference)
- Chitta — own verified benchmarks: [docs/BENCHMARKING.md](../BENCHMARKING.md), [README.md](../../README.md)
