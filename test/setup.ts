// Test preload (see bunfig.toml). Pin the deterministic hashing embedder so tests are
// fast, reproducible, and never download a model. Subprocesses spawned by tests (e.g. the
// MCP server in test/mcp/mcp.test.ts) inherit this via { ...process.env }.
process.env.CONTEXT_EMBEDDINGS = "hash"
