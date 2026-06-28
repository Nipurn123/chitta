# `src/context` - the permission-aware retrieval moat (native TS)

This is the **Phase-2 port** from the reuse blueprint: PipesHub's ~800-LOC
retrieval + ACL layer, rewritten natively in TypeScript so we own and control the
moat without a Python dependency. The heavy/commodity parts (connectors, parsers,
embeddings server, the Arango/Qdrant engines) stay as the backend; only the
*logic that decides who sees what* lives here.

## Provenance

| This file | Ported from (PipesHub) |
|---|---|
| `permission.ts` | `backend/python/app/models/permission.py` |
| `arango-graph-provider.ts` | `services/graph_db/arango/arango_http_provider.py` (`get_accessible_virtual_record_ids`, `_get_virtual_ids_for_connector`, `_get_kb_virtual_ids`, `_get_user_app_ids`) |
| `retrieval.ts` | `modules/retrieval/retrieval_service.py::search_with_filters` |
| `provider.ts`, `types.ts` | the interfaces those depend on |

## The security invariant (do not break)

`RetrievalService.searchWithFilters` enforces, in order:

1. **ACL first** - `getAccessibleVirtualRecordIds(user, org, filters)` computes the
   `{ virtualRecordId -> recordId }` map of everything the user may access, by
   traversing permission edges in the graph. Eight permission paths (direct,
   group×2, org×2, record-group inheritance×2, anyone) plus two KB paths.
2. **Restrict the search** - the vector query is filtered to those virtual ids.
   The model never sees a chunk outside this set.
3. **Cross-connector leak guard** - every hit resolves its `recordId` *from the
   accessible map*, never from the vector payload. If two connectors share a
   `virtualRecordId`, only the record this user may see is returned.

The AQL in `arango-graph-provider.ts` is preserved verbatim from the source. Each
path is a legitimate access route - dropping one silently denies access; loosening
one silently leaks data. Treat changes here as security-critical.

## The seams + adapters (now built - fetch-based, zero deps)

The three backend seams (`provider.ts`) each have a concrete **fetch-based** adapter -
no SDKs, no Node-only APIs, nothing leaves the boundary when the endpoints are local:

| Seam | Adapter | Talks to |
|---|---|---|
| `ArangoClient` | `arango-client.ts` | ArangoDB HTTP cursor API (`/_api/cursor`, drains multi-batch) |
| `VectorDBService` | `qdrant-vector.ts` | Qdrant REST (`/points/query/batch`, builds the filter) |
| `EmbeddingProvider` | `embeddings.ts` | OpenAI-compatible `/v1/embeddings` + optional sparse endpoint |

Wire it all from config in one call:

```ts
import { buildContextService } from "@/context/service"

const { retrieval } = buildContextService({
  arango: { url: "http://localhost:8529", database: "_system", username, password },
  qdrant: { url: "http://localhost:6333", apiKey },
  embeddings: { denseEndpoint: "http://localhost:8002", denseModel: "BAAI/bge-small-en-v1.5", sparseEndpoint },
  collectionName: "records",
})

const res = await retrieval.searchWithFilters({
  queries: [userQuery],
  userId,          // the asking user (env v0; → packages/identity later)
  orgId,
  filterGroups: { kb: [...], apps: [...] },
  limit: 20,
})
// res.searchResults are already ACL-filtered + cited.
```

Config comes from env in v0 (`config-env.ts`: `CONTEXT_ARANGO_URL`, `CONTEXT_QDRANT_URL`,
`CONTEXT_EMBED_URL`, `CONTEXT_COLLECTION`, `CONTEXT_USER_ID`, `CONTEXT_ORG_ID`, …).

## Exposed to the agent

`src/tool/context.ts` registers the **`get_context`** tool (in `src/tool/registry.ts`).
The agent calls it with a query; it returns ranked, cited, ACL-filtered snippets.

## Two deployment tiers (same moat, swapped adapters)

The ports-and-adapters design means the ACL + retrieval logic is identical across both;
only the backend adapters differ.

**Tier 1 - server-backed** (`arango-client.ts`, `qdrant-vector.ts`, `embeddings.ts`):
scales out, uses ArangoDB + Qdrant + an embedding server. Wired by `buildContextService`.

**Tier 2 - embedded / single-binary** (`embedded/`): one SQLite file + in-process
embeddings, **zero servers, zero Python**. Wired by `buildEmbeddedContext`:
- `embedded/sqlite-store.ts` - node/edge/chunk schema in one `.db`.
- `embedded/sqlite-graph-provider.ts` - the ACL traversal **ported from AQL to recursive SQL** (same access semantics; same `GraphProvider` interface).
- `embedded/sqlite-vec-service.ts` - brute-force cosine honoring the must/should ACL filter (swap in sqlite-vec for scale).
- `embedded/local-embeddings.ts` - deterministic in-process embedder (swap in transformers.js / fastembed ONNX `bge-*` for real semantic quality - same `EmbeddingProvider` interface).

```ts
import { buildEmbeddedContext } from "@/context/embedded"
const ctx = buildEmbeddedContext({ path: "knowledge.db" })  // one file, no servers
const res = await ctx.retrieval.searchWithFilters({ queries: [q], userId, orgId })
```

`bun build src/context/embedded/demo.ts --compile --outfile ctx` produces a single
self-contained ~59 MB executable. **Note (distribution):** bun-compiled binaries on
macOS arm64 need a code-signing/notarization step before they'll launch (the kernel
SIGKILLs unsigned ones); finalize that in the release packaging. The logic itself runs
identically via `bun run`.

## Verification

- `bun test` - 22 passing (ACL traversal, retrieval enforcement, adapter HTTP shaping, config).
- strict `tsc` (`strict` + `noUnusedLocals/Parameters` + `noImplicitOverride`) - 0 errors across all 11 production files.
- The module is **dependency-free** (relative imports + web `fetch` only) - no Python, no SDKs.

## Intentionally omitted (port later if needed)

- Cosmetic file/mail `webUrl` + mime fallback enrichment (`retrieval_service.py`
  462-532) - presentation, not access control.
- Embedding-model config/caching, BGE query prefixing - wire to our model config.

## Next steps (still net-new, per the blueprint)

- **Graph-level ACL propagation** - PipesHub enforces at the *record* level; push
  `acl_ref` down to extracted entities/edges (edge = intersection of endpoints).
- **Bi-temporal edges** - `valid_at`/`invalid_at` for non-destructive update/delete.
- **Late-binding verify** - re-check the top-K against live source perms.
- Wire `searchWithFilters` into `src/tool/context.ts` (`get_context`) and
  `src/cli/cmd/context.ts`, with `userId` supplied by `packages/identity`.
</content>
