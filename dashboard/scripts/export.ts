// Export the live context graph (SQLite) into a single JSON the dashboard reads.
//   bun run dashboard/export.ts            → reads $CONTEXT_DB or ~/.local/share/100xprompt/context.db
//   CONTEXT_DB=/path/to.db bun run dashboard/export.ts
// Writes dashboard/data/graph.json. Pure read-only; never mutates the DB.

import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { existsSync, mkdirSync, writeFileSync, statSync } from "node:fs"

const STRUCTURAL = new Set(["mentions", "permissions", "belongsTo", "inheritPermissions"])

const dbPath =
  process.env.CONTEXT_DB || join(homedir(), ".local/share/100xprompt/context.db")
if (!existsSync(dbPath)) {
  console.error(`No DB at ${dbPath}. Set CONTEXT_DB or ingest data first.`)
  process.exit(1)
}

const db = new Database(dbPath, { readonly: true })
const rows = <T = any>(sql: string, p: any[] = []): T[] => db.query(sql).all(...p) as T[]
const one = <T = any>(sql: string, p: any[] = []): T => db.query(sql).get(...p) as T

// ── Nodes ────────────────────────────────────────────────────────────────
const nodesByColl = rows<{ coll: string; n: number }>(
  "SELECT coll, COUNT(*) n FROM nodes GROUP BY coll ORDER BY n DESC",
)

const entityRows = rows<{ id: string; data: string }>(
  "SELECT id, data FROM nodes WHERE coll = 'entities'",
)
const entities = entityRows.map((r) => {
  const d = JSON.parse(r.data) as { label?: string; type?: string }
  return { id: r.id, label: d.label ?? r.id, type: d.type ?? "CONCEPT" }
})

const entityTypes = rows<{ type: string; n: number }>(
  "SELECT COALESCE(json_extract(data,'$.type'),'CONCEPT') type, COUNT(*) n FROM nodes WHERE coll='entities' GROUP BY type ORDER BY n DESC",
)

const records = rows<{ id: string; name: string; connector: string }>(
  "SELECT id, json_extract(data,'$.recordName') name, json_extract(data,'$.connectorName') connector FROM nodes WHERE coll='records'",
)

const users = rows<{ id: string; data: string }>(
  "SELECT id, data FROM nodes WHERE coll='users'",
).map((r) => ({ id: r.id, ...(JSON.parse(r.data) as any) }))

const orgs = rows<{ id: string; data: string }>(
  "SELECT id, data FROM nodes WHERE coll='organizations'",
).map((r) => ({ id: r.id, ...(JSON.parse(r.data) as any) }))

// ── Edges ────────────────────────────────────────────────────────────────
const edgesByLabel = rows<{ label: string; n: number }>(
  "SELECT label, COUNT(*) n FROM edges GROUP BY label ORDER BY n DESC",
)

const allEdges = rows<{
  src: string; dst: string; label: string; weight: number
  confidence: number; expired_at: number | null; valid_at: number | null; created_at: number
}>(
  "SELECT src,dst,label,weight,confidence,expired_at,valid_at,created_at FROM edges",
)

const entityIds = new Set(entities.map((e) => e.id))
// Entity↔entity relations (the knowledge-graph edges) - any non-structural predicate.
const relations = allEdges
  .filter((e) => !STRUCTURAL.has(e.label) && entityIds.has(e.src) && entityIds.has(e.dst))
  .map((e) => ({
    from: e.src, to: e.dst, type: e.label,
    weight: e.weight, confidence: e.confidence,
    live: e.expired_at == null,
    validAt: e.valid_at, createdAt: e.created_at,
  }))

// record → entity provenance (which doc surfaces which concept)
const mentions = allEdges
  .filter((e) => e.label === "mentions")
  .map((e) => ({ record: e.src, entity: e.dst }))

// principal → record ACL grants
const permissions = allEdges
  .filter((e) => e.label === "permissions")
  .map((e) => ({ principal: e.src, record: e.dst }))

const belongsTo = allEdges
  .filter((e) => e.label === "belongsTo")
  .map((e) => ({ src: e.src, dst: e.dst }))

// degree per entity (for node sizing in the graph)
const degree: Record<string, number> = {}
for (const r of relations) { degree[r.from] = (degree[r.from] ?? 0) + 1; degree[r.to] = (degree[r.to] ?? 0) + 1 }
for (const m of mentions) degree[m.entity] = (degree[m.entity] ?? 0) + 1
for (const e of entities) (e as any).degree = degree[e.id] ?? 0

// mentions-per-record (doc richness)
const recMentions: Record<string, number> = {}
for (const m of mentions) recMentions[m.record] = (recMentions[m.record] ?? 0) + 1
for (const r of records) (r as any).mentions = recMentions[r.id] ?? 0

const chunks = (one<{ n: number }>("SELECT COUNT(*) n FROM chunks") ?? { n: 0 }).n
let vecEnabled = false
try { db.query("SELECT COUNT(*) FROM vec_chunks").get(); vecEnabled = true } catch { vecEnabled = false }

// ── Vector store: real embeddings → PCA projection + kNN (for the Vectors view) ──
const chunkRows = rows<{ point_id: string; vrid: string; content: string; embedding: string }>(
  "SELECT point_id, virtual_record_id vrid, content, embedding FROM chunks",
)
const recName = new Map(records.map((r) => [r.id, r.name as string]))
const vecs: number[][] = []
const vchunks = chunkRows.map((r, i) => {
  let v: number[] = []
  try { v = JSON.parse(r.embedding) } catch { v = [] }
  vecs.push(v)
  return {
    id: r.point_id,
    vrid: r.vrid,
    record: recName.get(r.vrid) ?? r.vrid,
    preview: (r.content ?? "").slice(0, 120),
    idx: i,
  }
})
const dim = vecs[0]?.length ?? 0

// PCA via the Gram matrix (n×n, n=#chunks ≪ dim) - classical MDS / power iteration.
function pcaCoords(X: number[][], k: number): { coords: number[][]; explained: number[] } {
  const n = X.length
  if (n === 0) return { coords: [], explained: [] }
  const d = X[0].length
  const mean = new Array(d).fill(0)
  for (const r of X) for (let j = 0; j < d; j++) mean[j] += r[j] / n
  const Xc = X.map((r) => r.map((x, j) => x - mean[j]))
  // Gram G = Xc · Xcᵀ  (n×n)
  const G = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let a = 0; a < n; a++)
    for (let b = a; b < n; b++) {
      let s = 0
      for (let j = 0; j < d; j++) s += Xc[a][j] * Xc[b][j]
      G[a][b] = G[b][a] = s
    }
  const totVar = G.reduce((acc, row, a) => acc + row[a], 0) || 1
  const coords = Array.from({ length: n }, () => new Array(k).fill(0))
  const explained: number[] = []
  let M = G.map((r) => r.slice())
  for (let comp = 0; comp < k; comp++) {
    let v = Array.from({ length: n }, () => Math.random() - 0.5)
    let lambda = 0
    for (let it = 0; it < 200; it++) {
      const w = new Array(n).fill(0)
      for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) w[a] += M[a][b] * v[b]
      const norm = Math.sqrt(w.reduce((s, x) => s + x * x, 0)) || 1
      for (let a = 0; a < n; a++) w[a] /= norm
      lambda = norm
      v = w
    }
    const sl = Math.sqrt(Math.max(lambda, 0))
    for (let a = 0; a < n; a++) coords[a][comp] = v[a] * sl
    explained.push(lambda / totVar)
    // deflate: M -= lambda · vvᵀ
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) M[a][b] -= lambda * v[a] * v[b]
  }
  return { coords, explained }
}
const { coords, explained } = vecs.length ? pcaCoords(vecs, 3) : { coords: [], explained: [] }
vchunks.forEach((c, i) => {
  const p = coords[i] ?? [0, 0, 0]
  ;(c as any).x = +p[0].toFixed(4)
  ;(c as any).y = +p[1].toFixed(4)
  ;(c as any).z = +p[2].toFixed(4)
})

// cosine similarity matrix + top-5 nearest neighbours per chunk
const normed = vecs.map((v) => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
  return v.map((x) => x / n)
})
const cos = (a: number[], b: number[]) => a.reduce((s, x, j) => s + x * b[j], 0)
const sim: number[][] = normed.map((a) => normed.map((b) => +cos(a, b).toFixed(3)))
const knn = normed.map((_, i) =>
  sim[i]
    .map((s, j) => ({ j, s }))
    .filter((o) => o.j !== i)
    .sort((a, b) => b.s - a.s)
    .slice(0, 5),
)
const vectors = {
  dim,
  count: vchunks.length,
  vecEnabled,
  ann: vecEnabled ? "sqlite-vec vec0 (in-process ANN)" : "brute-force cosine",
  explained: explained.map((e) => +e.toFixed(4)),
  chunks: vchunks,
  sim,
  knn,
}

const stat = statSync(dbPath)
const out = {
  meta: {
    db: dbPath,
    generatedAt: new Date().toISOString(),
    dbBytes: stat.size,
    vecEnabled,
    counts: {
      nodes: nodesByColl.reduce((a, b) => a + b.n, 0),
      edges: edgesByLabel.reduce((a, b) => a + b.n, 0),
      entities: entities.length,
      relations: relations.length,
      records: records.length,
      chunks,
      mentions: mentions.length,
      liveRelations: relations.filter((r) => r.live).length,
      supersededRelations: relations.filter((r) => !r.live).length,
      predicates: new Set(relations.map((r) => r.type)).size,
    },
  },
  nodesByColl,
  edgesByLabel,
  entityTypes,
  entities,
  relations,
  records,
  users,
  orgs,
  mentions,
  permissions,
  belongsTo,
  vectors,
}

const outPath = join(dirname(import.meta.path), "..", "data", "graph.json")
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(out))
console.log(
  `✓ exported ${out.meta.counts.entities} entities · ${out.meta.counts.relations} relations · ` +
    `${out.meta.counts.records} records → ${outPath} (${(JSON.stringify(out).length / 1024).toFixed(1)} KB)`,
)
