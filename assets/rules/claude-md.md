<!-- chitta:start -->
## Memory (Chitta)

This project has **Chitta** - permission-aware long-term memory - available over MCP.
- Before answering anything that may depend on earlier work, call `get_context` to recall.
- When the user shares a durable fact, decision, or preference, call `context_ingest` to store it.
  If the response notes it superseded a previous belief, tell the user what changed.
- For "how are X and Y related", call `context_graph`.
- For "what does my memory look like" / a status check, call `context_health`.
Cite recalled snippets. Don't store secrets or throwaway state.
<!-- chitta:end -->
