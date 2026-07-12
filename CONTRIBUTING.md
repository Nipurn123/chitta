# Contributing

Thanks for your interest in Chitta. This is a small, dependency-light
codebase - easy to get into. Here's how.

## Development setup

You need [Bun](https://bun.sh) (the only runtime; no Node required).

```bash
git clone <your-fork>
cd chitta
bun install
bun test test/        # 124 tests - should be green before you start
```

## Project layout

- `src/` - the library. Core interfaces in `src/provider.ts`; the zero-server stack in
  `src/embedded/`; the MCP server in `src/mcp/`.
- `test/` - tests, mirroring `src/` (`test/embedded/…`, `test/mcp/…`).
- `examples/` - runnable, self-contained demos.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module-by-module map and the data flow.

## The workflow

1. **Branch** off `main` - never commit to `main` directly.
2. **Write a test first** when fixing a bug. One test file per module, under `test/`,
   mirroring the source path. Tests must be self-contained (no network, no fixtures
   outside the test).
3. **Make it pass** and keep the rest green:
   ```bash
   bun test test/
   bun run typecheck
   ```
4. **Match the surrounding style.** Read the file you're editing - comment density,
   naming, and idiom should be indistinguishable from the existing code.
5. **Open a PR** with a clear description of what changed and why. CI (`bun test` +
   typecheck) must pass.

## What to contribute

High-leverage areas (see the "Next" section of the [README](README.md#status)):

- **New backends** - implement `GraphProvider` / `VectorDBService` / `EmbeddingProvider`
  from `src/provider.ts`. The ACL/retrieval logic stays untouched; backends only move
  bytes. (See ARCHITECTURE.md → "Adding a new backend".)
- **Better extraction** - higher-recall entity/relationship extraction (the LLM path
  lives in `src/embedded/llm-extractor.ts`).
- **More language extractors** for the code-graph path (`src/embedded/code-extractor.ts`).
- **Examples** - a new self-contained demo under `examples/` is always welcome.

## Reporting bugs & security issues

- Functional bugs → open a GitHub issue with a minimal repro (a failing `*.test.ts` is
  perfect).
- Security issues → **do not** open a public issue; see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree your contributions are licensed under the
[MIT License](LICENSE).
