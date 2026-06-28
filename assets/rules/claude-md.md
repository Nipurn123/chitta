<!-- chitta:start -->
## Memory (Chitta)

This project has **Chitta** — permission-aware long-term memory — available over MCP.
- Before answering anything that may depend on earlier work, call `get_context` to recall.
- When the user shares a durable fact, decision, or preference, call `context_ingest` to store it.
- For "how are X and Y related", call `context_graph`.
Cite recalled snippets. Don't store secrets or throwaway state.
<!-- chitta:end -->
