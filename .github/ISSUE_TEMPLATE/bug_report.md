---
name: Bug report
about: Something isn't working as documented
title: ""
labels: bug
---

**What happened**
A clear description of the bug.

**Expected**
What you expected instead.

**Minimal repro**
A failing `*.test.ts` is ideal. Otherwise, the exact CLI/MCP calls:

```bash
# e.g.
bun run src/embedded/cli.ts ingest --id x --org o --name N --text "..."
```

**Environment**
- OS:
- Bun version (`bun --version`):
- Mode: local / central
- `store.vecEnabled` (if relevant): true / false

> ⚠️ For **security** issues (especially anything touching access control), do **not**
> open a public issue - see [SECURITY.md](../../SECURITY.md).
