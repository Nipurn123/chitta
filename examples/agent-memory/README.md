# Agent memory that survives a restart

The one "aha": **your AI coding agent remembers across sessions.**

Session 1 (one process) learns a few project facts and a preference, then exits.
Session 2 is a **brand-new process** that never saw session 1 run - it just opens the
**same SQLite file** and recalls everything, then rebuilds the knowledge graph from disk.
No servers, no API keys, no LLM tokens - the whole thing is offline and deterministic
(`embeddings: "hash"`, `rerank: false`).

## Run it

```bash
bun install                      # once, from the repo root
./examples/agent-memory/run.sh   # session 1 and session 2 as TWO separate processes
```

`run.sh` launches `bun run demo.ts session1` and then a **separate** `bun run demo.ts session2`
against one shared file - so persistence is proven across a real process boundary, not just
within one program. (Prefer a single process? `bun run examples/agent-memory/demo.ts` runs both
sessions back-to-back.) The demo `.db` is created fresh and deleted on exit.

## What it does

- **Session 1** opens a persistent store (`./agent-memory.db`), `remember()`s 5 facts - each
  with a precise **typed graph** (entities + `snake_case` relations, the zero-token path) - then
  `close()`s the store. The process ends.
- **Session 2** spins up a fresh `Chitta` on the **same file** and, for four natural-language
  questions, prints a **BEFORE** (an empty agent draws a blank) vs **AFTER** (the persisted store
  recalls the answer with a citation + score).
- Finally it prints the **knowledge graph** it learned - the most-connected concepts and the
  typed edges around each hub - reconstructed entirely from disk.

## Expected output

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  SESSION 1  the agent is working on the project and learns a few things
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  persistent store: ./agent-memory.db

  remembered  Chitta runs on Bun and stores everything in bun:sqlite - no servers, fully local.
  remembered  The retrieval entrypoint is searchWithGraph, wired up in the hybrid retriever; it blends vector, keyword, and graph search.
  remembered  We chose SQLite over Postgres so the memory layer stays zero-config and local-first.
  remembered  Nipurn prefers TypeScript with 2-space indentation and no semicolons.
  remembered  Run the test suite with `bun test test/`; the embedded SDK tests live in test/embedded.

  → persisted to disk: 5 records · 10 entities · 5 chunks
  → session closed. the agent's process is gone.

   ……… process A exited. launching a brand-new process B (same file) ………

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  SESSION 2  a fresh process, a brand-new Chitta instance, the SAME file
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  BEFORE - a brand-new agent, no memory of the last session:
     Q: what does Chitta run on?
     A: ¯\_(ツ)_/¯  I have no idea - I just started up.

  AFTER - …but Chitta remembered. Same file, new process:
     loaded 5 records · 10 entities from disk

     Q: what does Chitta run on?
     A: Chitta runs on Bun and stores everything in bun:sqlite - no servers, fully local.  (score 0.294)

     Q: where is the retrieval entrypoint?
     A: The retrieval entrypoint is searchWithGraph, wired up in the hybrid retriever; it blends vector, keyword, and graph search.  (score 0.439)

     Q: what indentation does Nipurn prefer?
     A: Nipurn prefers TypeScript with 2-space indentation and no semicolons.  (score 0.263)

     Q: what did we choose for zero-config local-first storage?
     A: We chose SQLite over Postgres so the memory layer stays zero-config and local-first.  (score 0.379)


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  THE KNOWLEDGE GRAPH  entities + typed relations, rebuilt from the file
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Most-connected concepts (degree = typed edges)
     ▮▮▮▮▮▮ Chitta · 6
     ▮▮ searchWithGraph · 2
     ▮▮ TypeScript · 2
     ▮ Bun · 1
     ▮ bun:sqlite · 1
     ▮ hybrid retriever · 1

  Chitta is connected to:
     Chitta ──runs_on──▶ Bun
     Chitta ──stores_data_in──▶ bun:sqlite
     Chitta ──retrieves_with──▶ searchWithGraph
     Chitta ──built_on──▶ SQLite
     Chitta ──written_in──▶ TypeScript
     Chitta ──tested_with──▶ bun test

  Nipurn is connected to:
     Nipurn ──prefers──▶ TypeScript

──────────────────────────────────────────────────────────────────
  aha: session 2 never saw session 1 run - it only opened the file,
       and recalled the facts + reconstructed the graph. That's cross-session memory.
──────────────────────────────────────────────────────────────────
```

## Notes

- **Offline & deterministic.** `embeddings: "hash"` uses a lexical hash embedder (no model
  download); `rerank: false` skips the cross-encoder. Great for a reproducible demo. For real
  semantic recall in your app, drop both options - the default `"auto"` embedder + reranker turn on.
- **Persistence is just a file path.** The only thing that makes memory durable is passing
  `path` instead of the default `":memory:"`. Point two processes at the same path and they
  share one brain.
- **Zero-token graph.** Each `remember()` carries the `entities`/`relations` you already know,
  so no second model re-reads the text - the typed triples are stored exactly and power the
  graph view above.
