---
name: chitta
description: Permission-aware long-term memory for AI agents. Use to recall prior context before answering, store durable facts/decisions/preferences, and query how concepts relate. Backed by Chitta's MCP tools (context_ingest, get_context, context_graph) with a CLI fallback. Trigger whenever a task may depend on earlier work, when the user shares something worth remembering, or when asked how things connect.
---

# Chitta — memory for this agent

Chitta (चित्त, "the mind's storehouse") gives you persistent, **permission-aware** memory: a
knowledge graph + vector store exposed over MCP. Each user only ever sees what their
permissions allow. Use it proactively — memory is only useful if you reach for it.

## When to use it

1. **Recall before answering.** If a request might depend on prior decisions, context, or
   facts ("what did we decide about X", "continue the Y work", anything project-specific),
   call **`get_context`** first with the question. It returns ranked, cited,
   permission-filtered snippets. Cite what you use.
2. **Store durable knowledge.** When the user states a lasting fact, decision, preference, or
   you produce an artifact worth remembering, call **`context_ingest`** with the text (and a
   short `recordName`). Don't store secrets, throwaway chatter, or transient state.
3. **Reason over connections.** For "how are X and Y related" or to map a topic, call
   **`context_graph`** to get the concepts + relationships the user can access.

## The MCP tools

| Tool | Use |
|---|---|
| `get_context` | Retrieve ranked, cited, permission-filtered snippets for a query |
| `context_ingest` | Store text → record + permission edges + vector chunks + extracted concept graph |
| `context_graph` | Return the accessible knowledge graph (concepts + relationships) |

## CLI fallback (no MCP)

If MCP tools aren't available in this environment, shell out:

```bash
bunx @100xprompt/chitta query "<question>"          # recall
bunx @100xprompt/chitta ingest --text "<fact>" --name "<title>"   # store
```

## Guardrails

- Respect permissions: never try to surface content a user isn't entitled to; Chitta enforces
  this, but don't work around it.
- Prefer recalling over guessing. If `get_context` returns nothing relevant, say so rather
  than inventing.
- Keep stored entries concise and factual; one idea per ingest.
