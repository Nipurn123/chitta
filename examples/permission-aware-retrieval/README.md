# Worked example: permission-aware retrieval

The whole point of Chitta in one runnable script: **two users share one
knowledge store, but each sees only what their permissions allow.** No servers - one
SQLite file.

```bash
bun install
./examples/permission-aware-retrieval/run.sh
```

## The setup

Org `acme`, two users, three documents with three different sharing scopes:

| Document | Shared with | Alice sees? | Bob sees? |
|---|---|:--:|:--:|
| Company Handbook | whole org | ✅ | ✅ |
| Eng Roadmap | `alice` only | ✅ | ❌ |
| Comp Bands | `bob` only | ❌ | ✅ |

## The result (actual output)

Both users run the **same query** - and get **different, permission-filtered** results:

```
── Same query, two users, different results ──────────────────
ALICE (org handbook + her roadmap; NOT comp):
status: SUCCESS
  • [Company Handbook] Acme builds privacy-first AI infrastructure. All employees get unlimited PTO and
  • [Eng Roadmap] Q3 roadmap: ship the permission-aware retrieval engine. Alice leads the ACL grap

BOB (org handbook + his comp; NOT roadmap):
status: SUCCESS
  • [Company Handbook] Acme builds privacy-first AI infrastructure. All employees get unlimited PTO and
  • [Comp Bands] Compensation bands for 2026. Senior engineers: 180-220k base. Staff: 230-280k.
```

Alice never sees Comp Bands; Bob never sees the Roadmap. The permission check isn't a
post-filter you can forget - the ACL graph **produces the candidate set** before the
vector index is ever touched (see [ARCHITECTURE.md](../../ARCHITECTURE.md#the-security-invariant)).

## One shared graph

All three records contribute to a single knowledge graph - entities mentioned across
documents link through shared concept nodes:

```
── Shared knowledge graph across all 3 records ───────────────
rebuilt knowledge graph: 3 records → 11 concept-mentions
```

Each user's `context_graph` view is sliced to the records they can access - the backbone
is shared, the visibility is per-user.

## From an MCP client

The same thing the CLI does here is exposed over MCP as `context_ingest`, `get_context`,
and `context_graph` - so Claude Code, Cursor, or any MCP client gets permission-aware
memory with zero code changes. See the [root README](../../README.md).
