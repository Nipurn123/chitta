---
name: chitta
description: Permission-aware long-term memory for AI agents. Use to recall prior context before answering, store durable facts/decisions/preferences, profile a person/entity, forget retracted facts, and query how concepts relate. Backed by Chitta's MCP tools (get_context, context_ingest, context_forget, context_profile, context_graph, context_relate) with a CLI fallback. Trigger whenever a task may depend on earlier work, when the user shares something worth remembering, when a fact is retracted, or when asked who/what something is or how things connect.
---

# Chitta - memory for this agent

Chitta (चित्त, "the mind's storehouse") gives you persistent, **permission-aware** memory: a
knowledge graph + vector store exposed over MCP. Each user only ever sees what their
permissions allow. Use it proactively - memory is only useful if you reach for it.

## When to use it

1. **Recall before answering.** If a request might depend on prior decisions, context, or
   facts ("what did we decide about X", "continue the Y work", anything project-specific),
   call **`get_context`** first with the question. It returns ranked, cited,
   permission-filtered snippets. Cite what you use.
2. **Store durable knowledge.** When the user states a lasting fact, decision, preference, or
   you produce an artifact worth remembering, call **`context_ingest`** with the text plus the
   `entities` and `relations` you identified (precise typed triples). Don't store secrets,
   throwaway chatter, or transient state.
3. **Forget what's retracted.** When the user says "forget that" or a fact is no longer true,
   call **`context_forget`** with a description of what to drop (the new value alone also
   auto-supersedes an old single-valued fact on ingest).
4. **Profile a subject.** For "who is X" / "what do we know about X", call **`context_profile`**
   - it returns permanent facts + recent facts (contradictions already resolved) + connections.
5. **Reason over connections.** For "how are X and Y related" or to map a topic, call
   **`context_graph`** (the concept map) or **`context_relate`** (neighbors / path / impact).

## The MCP tools

| Tool | Use |
|---|---|
| `get_context` | Ranked, cited, permission-filtered recall + current (contradiction-resolved) memory |
| `context_ingest` | Store text → record + permission edges + vector chunks + concept graph + atomic memories |
| `context_forget` | Forget memories that are no longer true/wanted (soft-delete, within your access) |
| `context_profile` | Profile a person/org/entity: permanent + recent facts + connections |
| `context_graph` | Return the accessible knowledge graph (concepts + relationships) |
| `context_relate` | Graph queries over the entity graph (neighbors / path / impact / central) |

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
