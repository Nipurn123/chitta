// Test preload (see bunfig.toml). Pin the deterministic hashing embedder so tests are
// fast, reproducible, and never download a model. Subprocesses spawned by tests (e.g. the
// MCP server in test/mcp/mcp.test.ts) inherit this via { ...process.env }.
process.env.CONTEXT_EMBEDDINGS = "hash"
// Same for the cross-encoder the server enables by default: loading it on a fresh install took
// longer than the MCP endpoint test's 5 s limit. Reranker tests inject their own; set
// CONTEXT_RERANK=1 to run the suite with the real model.
process.env.CONTEXT_RERANK ??= "0"
