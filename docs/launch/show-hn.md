# Show HN — draft

## Title options (pick one)

1. Show HN: Chitta – a local, zero-token memory layer for AI coding agents
2. Show HN: I got tired of re-explaining my project to Claude every morning, so I fixed it
3. Show HN: Persistent memory for coding agents that never calls an LLM (SQLite + local embeddings)

---

## Post body

**What it is:** Chitta is a knowledge-graph + vector memory that plugs into your AI coding
agent over MCP (Claude Code, Cursor, Windsurf, Codex CLI, Gemini CLI, Zed, etc.) and
remembers your project across sessions — without spending an LLM token to store or search
anything.

**The pain:** every time I closed my terminal, the agent forgot everything. New session,
same re-explanation: here's the architecture, here's why it's Postgres not Mongo, here's
what we decided last Tuesday. I had a `CLAUDE.md` I kept hand-editing, and I *still* ended
up re-pasting context into the chat because a static file can't hold everything that comes
up. I didn't want a better note file. I wanted the agent to just remember.

**How it works:** one command installs an MCP server (and, on tools that support it, a
`SKILL.md` that teaches the agent when to use it — you don't write or maintain that part).
From then on your agent calls two tools as it works: `context_ingest` to store a fact,
decision, or preference, and `get_context` to recall before it answers. Under that:

- A deterministic entity/relation extractor turns what you tell it into a typed graph
  (`Sarah --works_at--> Meta`). It's a parser, not a prompt — no LLM call.
- Retrieval fuses BM25 + local embeddings + a bounded graph hop, then reranks with a small
  cross-encoder. Also no LLM call — the only tokens spent are the ones your agent was
  already going to spend answering you.
- Everything lives in one SQLite file on your machine (`~/.local/share/100xprompt/context.db`).
  No server, no signup, no API key, works offline.
- You can ask "how does X relate to Y" and get back the actual graph (`context_graph`),
  not a paraphrase of one.

Numbers I'll actually stand behind (measured, reproducible via `chitta bench`, methodology
in the repo):

- **0.782** recall@10 on LongMemEval, **0.552** on LoCoMo Tier-A — retrieval only, zero LLM
  tokens spent to get there.
- **~100ms** per query.
- On LoCoMo, retrieval hands the reader **~181 tokens** of evidence instead of the full
  **25,864-token** conversation history — 143× less for your agent to read before it
  answers.

Install:

```bash
bunx @100xprompt/chitta install
```

That auto-detects which of the 17 supported tools you have and wires each one in
(`--platform cursor,claude-code` to target specific ones, `--print` to just get the MCP
config to paste somewhere it doesn't auto-detect). It's also a plain TypeScript SDK if
you're building your own agent:

```ts
import { Chitta } from "@100xprompt/chitta"
const memory = new Chitta({ path: "./memory.db" })
await memory.remember("Sarah works at Meta.", { relations: [{ from: "Sarah", to: "Meta", type: "works_at" }] })
await memory.recall("where does Sarah work?")
```

**What it's not / limitations, honestly:**

- The default embedder is a fast, dependency-free hashing scheme, not a neural net — it
  works offline instantly with zero downloads, but it's weaker than real semantic search
  until you opt into the local model (`bun add @huggingface/transformers`, one env var),
  which pulls in `bge-small` (384-dim, runs on CPU via ONNX).
- The zero-token extractor is deterministic and pattern-based, so it's genuinely worse than
  an LLM at pulling structure out of messy, casual conversation — that's exactly why the
  numbers above are labeled retrieval-only. There's an opt-in hybrid mode that spends LLM
  tokens (yours, or your own local model) for higher recall, but it is not the default and
  never runs silently.
- It's Bun-only right now, not Node.
- Pre-1.0 (currently 0.3.0) — I've tried to keep the SDK surface stable, but it can still
  move.
- I've measured it to 100K records/vectors on my own laptop. That's the largest number I
  have real data for; I'm not going to claim "enterprise scale" I haven't tested.
- LoCoMo has documented label-noise issues (a known property of the public dataset, not
  specific to Chitta) — weight LongMemEval higher if you're comparing memory tools on it.
- There's a permission-aware ACL layer underneath (so if this ever ends up shared by a
  team, each person only sees what they're allowed to) — but that's not what this launch is
  about. Today this is aimed at one person's agent on one machine.

MIT-licensed, on npm as `@100xprompt/chitta`, source at github.com/Nipurn123/chitta. Happy
to get into the retrieval pipeline, the extractor, or why SQLite instead of a "real" vector
database — ask away.
