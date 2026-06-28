# context · dashboard

A Next.js visual layer for the `context-mcp` knowledge graph - renders the **real** data
from your live `context.db` (entities, typed relations, ACL, vector chunks) as an
n-dimensional graph plus a set of data-structure dashboards.

```
npm install
npm run sync     # snapshot the live SQLite → data/graph.json  (uses bun)
npm run dev      # http://localhost:4317
```

## Views

| Tab | What it shows |
|---|---|
| **Graph** | Force-directed knowledge graph. **2D / 3D-rotating** projection, drag nodes, scroll-zoom, search, per-type filtering, click a node to focus its neighborhood + see typed relations. Toggle the `records` layer to overlay `mentions` (doc→concept) edges. |
| **Structures** | Counts, nodes-by-collection, edges-by-label, entity-type donut, and the live `nodes / edges / chunks / vec_chunks` storage schema. |
| **Vectors** | The vector store made visible. **PCA projection** (computed from the real 384-dim embeddings) of every chunk into a 2D/3D scatter, colored by source record; click a point to draw its top-5 nearest neighbors by cosine. Side rail shows index stats + variance explained per principal component; below is the full **cosine-similarity heatmap**. |
| **Access** | Permission-resolution flow (org → principals → grants → accessible records) and the eight ACL paths. |
| **Pipeline** | The ingest → ACL → embed → extract → retrieve → leak-guard flow. |

## Data flow - live by default

`context.db` (SQLite) → `lib/live.ts` reads it **directly on every request** via Node's built-in
`node:sqlite` (Node 22+) → server component (`app/page.tsx`) → client views. The client also
**auto-polls `/api/graph` every 4s** and re-renders only when the content actually changed - so
editing the DB shows up in the UI within ~4s, no reload. Toggle/pause it with the **LIVE** chip
top-right.

If the DB isn't reachable it falls back to the `data/graph.json` snapshot (`npm run sync` to
refresh that). Point at a different DB: `CONTEXT_DB=/path/to.db`.

## Stack

Next.js 14 (App Router) · TypeScript · Tailwind. The force graph is a dependency-free
canvas renderer (`components/GraphView.tsx`) - own 2D/3D simulation, no graph libraries.
