# X / Twitter launch thread — draft (10 tweets)

Two attachments needed — grab them before posting:
- `[ATTACH: knowledge-graph GIF]` → a real one already exists in the repo at
  `docs/assets/chitta-graph.gif` (285 concepts, 291 relationships, rotating 3D render).
- `[ATTACH: "it remembered" demo clip]` → record fresh: close a session, open a new one,
  ask about something told to it days earlier, show the recall happening live.

---

**1/**
Your AI coding agent has amnesia.

Close the terminal and it forgets your architecture, your conventions, yesterday's
decisions. New session, re-explain everything. Again.

I got tired of being my own agent's memory. So I gave it one.

**2/**
Here's what that looks like now. New session, cold start, I ask about something I told it
days ago:

[ATTACH: "it remembered" demo clip]

**3/**
The trick: it's not another chat log getting stuffed back into your context window. It's a
real memory — entities, facts, relationships — held in a knowledge graph. And it costs zero
LLM tokens to build or search.

**4/**
No LLM call to extract facts. No LLM call to retrieve them. A deterministic parser builds
the graph; local embeddings + a small on-device reranker handle search. The only tokens
spent are the ones your agent was already spending to answer you.

**5/**
It's a real graph, not a metaphor. Here's one Chitta actually built from real usage —
entities colored by type, sized by how connected they are:

[ATTACH: knowledge-graph GIF]

**6/**
Measured, not vibes:
• 0.782 recall@10 on LongMemEval
• 0.552 on LoCoMo (zero-token, retrieval-only)
• ~100ms per query
• on LoCoMo: ~181 tokens of evidence handed back instead of the full 25,864-token history

**7/**
All of it lives in one SQLite file, on your machine. No server, no signup, no API key,
works offline. Copy the file, that's your backup. Delete it, that's the whole data model.

**8/**
It plugs into whatever you already use — Claude Code, Cursor, Windsurf, Codex CLI, Gemini
CLI, Zed, and 11 others. 17 tools, auto-detected. Same memory, wherever you're coding.

**9/**
Also works as a plain TypeScript SDK if you're building your own agent:
`import { Chitta } from "@100xprompt/chitta"`
There's a permission-aware ACL layer underneath too (useful once a team shares one graph) —
but that's a story for another day.

**10/**
Try it:
`bunx @100xprompt/chitta install`

One command, auto-detects the tool you already use. MIT-licensed, open source:
github.com/Nipurn123/chitta
