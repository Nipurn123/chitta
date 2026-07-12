// HippoRAG-style Personalized PageRank (PPR) retrieval over the entity graph.
//
// WHY: the bounded hop (knowledge-graph.ts) reaches evidence ONE relation edge away
// from the seed entities. Multi-hop questions ("what runs on the thing Zephyr uses?")
// need evidence 2-3 edges out, where a single hop is structurally blind. PPR fixes
// this the HippoRAG way: put activation mass on the query's entities, spread it over
// the typed graph with restart, and rank records by how much mass their entities
// accumulated - a record reachable via MANY short paths beats one dangling off a
// single long path. Zero tokens: pure SQL reads + a Float64Array power iteration.
//
// SECURITY INVARIANT (same fail-closed rule as knowledge-graph.ts, preserved exactly):
//   - a relation edge participates ONLY if a record the user may access ASSERTED it
//     (provenance ∩ accessible ≠ ∅). Endpoint visibility is NOT enough - two visible
//     entities can have a relationship stated only in a record the user can't see.
//     No provenance match ⇒ the edge does not exist for this walk.
//   - entity mass maps to records ONLY over mentions edges whose src is accessible,
//     and the per-record share divides by the ACCESSIBLE mention count only - a
//     score must never depend on how many INACCESSIBLE records mention an entity.
//
// BOUNDED (independent of graph size, like the bounded hop): seeds, expansion hops,
// per-hop frontier, total nodes, total edges, and iterations are all capped; hub
// entities (mention-degree > hub, detected with a LIMIT hub+1 scan so the check is
// O(hub) not O(hub-size)) never seed, never expand, and never map to records - their
// mass evaporates instead of flooding 40 records with noise. On a graph too dense
// for the caps the walk degrades gracefully: it sees a truncated neighborhood and
// still returns a normalized ranking over what it saw.

import type { SqlAccess } from "./sql-access"

// The walk follows TYPED predicates only - 'relates_to' (co-occurrence) is excluded on
// top of the structural labels. Measured on LoCoMo: conversational text weaves a dense
// co-occurrence web (every entity pair in a turn relates), and walking it diffuses mass
// everywhere, burying the true multi-hop paths in noise. Typed edges are the extractor's
// high-precision tier; restricting the walk to them is what makes the PPR leg additive
// instead of harmful. (The 1-hop graph stage still uses co-occurrence - one hop of it is
// signal; compounding it over 2-3 hops is not.)
const WALK_EXCL = "('mentions','permissions','belongsTo','inheritPermissions','relates_to')"

export interface PprOptions {
  /** Walk-continue probability; (1 - alpha) restarts to the seed distribution.
   *  Lower = stay near the seeds; higher = wander further. HippoRAG uses ~0.5. */
  alpha: number
  /** Power-iteration cap (early-exits on convergence well before this). */
  iters: number
  /** Expansion radius in relation-edge hops from the seeds (2 hops already covers
   *  record -> entity -> entity -> entity -> record, i.e. a 3-record chain). */
  hops: number
  /** Mention-degree above which an entity is a hub (same knob family as the bounded
   *  hop's CONTEXT_GRAPH_HUB): bridges to everything, so it is noise, not signal. */
  hub: number
  maxSeeds: number
  /** New entities admitted to expansion per hop (rarest-first, like the bounded hop). */
  maxFrontier: number
  maxNodes: number
  maxEdges: number
  /** Ranked records returned. */
  limit: number
}

export function pprDefaults(): PprOptions {
  return {
    alpha: Number(process.env.CONTEXT_GRAPH_PPR_ALPHA ?? 0.5),
    iters: Number(process.env.CONTEXT_GRAPH_PPR_ITERS ?? 12),
    hops: Number(process.env.CONTEXT_GRAPH_PPR_HOPS ?? 3),
    hub: Number(process.env.CONTEXT_GRAPH_HUB ?? 60),
    maxSeeds: Number(process.env.CONTEXT_GRAPH_PPR_SEEDS ?? 16),
    maxFrontier: Number(process.env.CONTEXT_GRAPH_MAXNB ?? 64),
    maxNodes: Number(process.env.CONTEXT_GRAPH_PPR_NODES ?? 256),
    maxEdges: Number(process.env.CONTEXT_GRAPH_PPR_EDGES ?? 2048),
    // Small on purpose: every fused item competes for top-k slots, so a long tail of
    // low-mass records displaces the other legs' candidates (measured on LoCoMo).
    limit: Number(process.env.CONTEXT_GRAPH_PPR_LIMIT ?? 8),
  }
}

interface Edge {
  src: string
  dst: string
  weight: number
}

/** PPR record retrieval: seed mass on the query's entities, walk the ACL-accessible
 *  subgraph, map final entity mass -> record scores via accessible mentions edges.
 *  Returns records ranked by accumulated mass (desc), capped to opts.limit.
 *  `accessible` is the user's accessible RECORD-id set - every edge and every
 *  mention is gated on it (fail-closed: not provably accessible ⇒ ignored). */
export function pprRecordScores(
  sql: SqlAccess,
  seedEntityIds: string[],
  accessible: ReadonlySet<string>,
  opts: PprOptions = pprDefaults(),
): Array<{ recordId: string; score: number }> {
  if (seedEntityIds.length === 0 || accessible.size === 0) return []

  // Per-entity mention rows, capped at hub+1 (O(hub) regardless of true degree) and
  // memoized - seeding, frontier ranking, and record mapping all reuse the same rows.
  const mentionCache = new Map<string, string[]>()
  const mentionSrcs = (entId: string): string[] => {
    let rows = mentionCache.get(entId)
    if (!rows) {
      rows = sql
        .rows<{ src: string }>(`SELECT src FROM edges WHERE label = 'mentions' AND dst = ? LIMIT ${opts.hub + 1}`, [entId])
        .map((r) => r.src)
      mentionCache.set(entId, rows)
    }
    return rows
  }
  const isHub = (entId: string): boolean => mentionSrcs(entId).length > opts.hub
  const accMentions = (entId: string): string[] => (isHub(entId) ? [] : mentionSrcs(entId).filter((r) => accessible.has(r)))

  // ── seeds: only entities VISIBLE to this user (mentioned by ≥1 accessible record),
  // never hubs, rarest (most discriminating) first, capped. Seed weight ∝ 1/df over the
  // ACCESSIBLE mentions (HippoRAG node specificity): a rare query entity anchors the
  // walk; a common one contributes but cannot dominate the restart distribution.
  const seeds = [...new Set(seedEntityIds)]
    .map((id) => ({ id, df: accMentions(id).length }))
    .filter((s) => s.df > 0)
    .sort((a, b) => a.df - b.df)
    .slice(0, opts.maxSeeds)
  if (seeds.length === 0) return []

  // ── bounded subgraph expansion: hop out from the seeds along LIVE, provenance-
  // accessible relation edges. Every step is capped, so cost never scales with N.
  const nodes = new Set<string>(seeds.map((s) => s.id))
  const edges: Edge[] = []
  const edgeSeen = new Set<string>()
  let frontier = seeds.map((s) => s.id)
  for (let hop = 0; hop < opts.hops && frontier.length > 0 && nodes.size < opts.maxNodes && edges.length < opts.maxEdges; hop++) {
    const fp = sql.ph(frontier.length)
    // Incident live typed edges, scanned with slack for rows the provenance gate drops.
    // A denser-than-budget neighborhood truncates here - graceful degradation, never O(N).
    const scan = Math.min(opts.maxEdges * 2, 4096)
    const raw = sql.rows<{ src: string; dst: string; weight: number; provenance: string }>(
      `SELECT src, dst, weight, provenance FROM (
          SELECT src, dst, weight, provenance FROM edges
            WHERE label NOT IN ${WALK_EXCL} AND expired_at IS NULL AND src IN (${fp})
          UNION
          SELECT src, dst, weight, provenance FROM edges
            WHERE label NOT IN ${WALK_EXCL} AND expired_at IS NULL AND dst IN (${fp})
       ) LIMIT ${scan}`,
      [...frontier, ...frontier],
    )
    const discovered = new Set<string>()
    for (const r of raw) {
      if (edges.length >= opts.maxEdges) break
      // THE leak-guard: the edge exists for this user only if an accessible record
      // asserted it. Malformed/empty provenance fails closed (no match ⇒ dropped).
      let prov: string[]
      try {
        prov = JSON.parse(r.provenance || "[]") as string[]
      } catch {
        continue
      }
      if (!prov.some((p) => accessible.has(p))) continue
      const key = r.src < r.dst ? `${r.src} ${r.dst}` : `${r.dst} ${r.src}` // undirected pair
      if (edgeSeen.has(key)) continue // parallel predicates between a pair: one arc of flow is enough
      edgeSeen.add(key)
      edges.push({ src: r.src, dst: r.dst, weight: r.weight > 0 ? r.weight : 1 })
      for (const end of [r.src, r.dst]) if (!nodes.has(end)) discovered.add(end)
    }
    // Admit the most SPECIFIC discoveries (rarest mention-degree first, hubs never),
    // capped per hop - the same anti-flood shape as the bounded hop's neighbor cap.
    const admitted = [...discovered]
      .map((id) => ({ id, deg: mentionSrcs(id).length }))
      .filter((x) => x.deg <= opts.hub)
      .sort((a, b) => a.deg - b.deg)
      .slice(0, Math.min(opts.maxFrontier, opts.maxNodes - nodes.size))
      .map((x) => x.id)
    for (const id of admitted) nodes.add(id)
    frontier = admitted
  }

  // ── power iteration with restart over the collected subgraph (undirected: evidence
  // relevance flows both ways along a fact). Dangling mass (a node whose edges were
  // all truncated or seed with no accessible relations) restarts to the seeds instead
  // of leaking, so the vector stays normalized (Σr = 1) at every step.
  const ids = [...nodes]
  const idx = new Map(ids.map((id, i) => [id, i]))
  const n = ids.length
  const adjHead = new Int32Array(n).fill(-1) // per-node linked list over the arcs
  const arcTo: number[] = []
  const arcW: number[] = []
  const arcNext: number[] = []
  const deg = new Float64Array(n)
  const addArc = (a: number, b: number, w: number) => {
    arcTo.push(b)
    arcW.push(w)
    arcNext.push(adjHead[a])
    adjHead[a] = arcTo.length - 1
    deg[a] += w
  }
  for (const e of edges) {
    const a = idx.get(e.src)
    const b = idx.get(e.dst)
    if (a === undefined || b === undefined || a === b) continue // endpoint past the node cap ⇒ arc dropped
    addArc(a, b, e.weight)
    addArc(b, a, e.weight)
  }
  const teleport = new Float64Array(n)
  {
    let z = 0
    for (const s of seeds) z += 1 / s.df
    for (const s of seeds) teleport[idx.get(s.id) as number] = 1 / s.df / z
  }
  let r = Float64Array.from(teleport)
  for (let it = 0; it < opts.iters; it++) {
    const next = new Float64Array(n)
    let dangling = 0
    for (let i = 0; i < n; i++) {
      if (r[i] === 0) continue
      if (deg[i] === 0) {
        dangling += r[i] // nowhere to walk ⇒ full restart
        continue
      }
      const share = (opts.alpha * r[i]) / deg[i]
      for (let a = adjHead[i]; a !== -1; a = arcNext[a]) next[arcTo[a]] += share * arcW[a]
      dangling += (1 - opts.alpha) * r[i] // the restart fraction of walking nodes
    }
    let delta = 0
    for (let i = 0; i < n; i++) {
      const v = next[i] + dangling * teleport[i]
      delta += Math.abs(v - r[i])
      next[i] = v
    }
    r = next
    if (delta < 1e-9) break // converged - typical for bounded subgraphs in ~5-8 iters
  }

  // ── entity mass -> record scores over ACCESSIBLE mentions only. Each entity splits
  // its mass evenly across the accessible records mentioning it (P(walker at e) ×
  // P(pick a record of e)) - so a 40-record hub-ish entity hands each record 1/40 of
  // its mass while a 1-record specific entity hands its record everything. That, plus
  // hubs being excluded outright, is what keeps a mega-entity from dominating.
  // SEED entities do NOT map: records that directly mention the query's entities are
  // the dense/sparse/1-hop legs' job (and in dialogue the speaker is a query entity
  // mentioned by nearly every record - mapping it floods the list with the whole
  // conversation). This leg exists for what the walk REACHED, not where it started.
  const seedIdSet = new Set(seeds.map((s) => s.id))
  const recScore = new Map<string, number>()
  for (let i = 0; i < n; i++) {
    if (r[i] <= 0 || seedIdSet.has(ids[i])) continue
    const recs = accMentions(ids[i])
    if (recs.length === 0) continue
    const share = r[i] / recs.length
    for (const rec of recs) recScore.set(rec, (recScore.get(rec) ?? 0) + share)
  }
  return [...recScore.entries()]
    .map(([recordId, score]) => ({ recordId, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit)
}
