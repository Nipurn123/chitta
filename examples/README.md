# Examples

Runnable, self-contained demos. Each is a single command after `bun install`.

| Example | Shows |
|---|---|
| [permission-aware-retrieval](permission-aware-retrieval/) | Two users share one store; each sees only what their permissions allow - the core ACL moat. |
| [token-reduction](token-reduction/) | A reproducible benchmark: **7.4× fewer tokens** than dumping the whole knowledge base, with zero cross-user leak. |

```bash
bun install
./examples/permission-aware-retrieval/run.sh        # the ACL demo
bun run examples/token-reduction/benchmark.ts        # the benchmark
```

Want to add one? See [CONTRIBUTING.md](../CONTRIBUTING.md) - a new self-contained demo is
always welcome.
