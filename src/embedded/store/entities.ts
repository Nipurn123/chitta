// Entity-alias persistence + retroactive entity merge - the SQL half of the
// canonicalization layer (the matching logic is pure in graph/entity-resolution.ts).
//
// The alias table maps every surface-form slug we've seen → the canonical entity id it
// resolves to, so the resolver's common case is an O(1) lookup. `mergeEntities` folds two
// already-separate canonicals into one (used by the backfill dedupe pass on pre-existing
// data) - NON-DESTRUCTIVELY re-pointing edges + memory subject_keys, preserving the
// bi-temporal validity + provenance + weight semantics the rest of the store depends on.

import { Database } from "bun:sqlite"
import { slugify } from "../extract"
import {
  indexTokens,
  blockingTokens,
  typeBucket,
  type AliasStore,
  type EntityCandidate,
  type TypeBucket,
} from "../graph/entity-resolution"

export function migrateEntityAliases(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_aliases (
      alias_slug   TEXT PRIMARY KEY,
      canonical_id TEXT NOT NULL,
      surface      TEXT NOT NULL,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_aliases_canonical ON entity_aliases(canonical_id);
    -- Token-blocking index: maps a distinctive label token → the entities carrying it, so
    -- candidate generation is an indexed point lookup instead of an O(N) LIKE scan over
    -- every entity on every ingest. (token, entity_id) is the identity; idx on token keys
    -- the lookup; idx on entity_id keys re-pointing/cleanup on merge.
    CREATE TABLE IF NOT EXISTS entity_tokens (
      token     TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      PRIMARY KEY (token, entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_entity_tokens_token ON entity_tokens(token);
    CREATE INDEX IF NOT EXISTS idx_entity_tokens_entity ON entity_tokens(entity_id);
  `)
  // Backfill token rows for entities that predate this table (data ingested before the
  // token index existed), so blocking works for them immediately - not only for entities
  // created after the migration. Idempotent (INSERT OR IGNORE).
  backfillEntityTokens(db)
}

function safeParseData(data: string): { label?: string; type?: string } {
  try {
    return JSON.parse(data) as { label?: string; type?: string }
  } catch {
    return {}
  }
}

/** (Re)populate entity_tokens from the CURRENT entity nodes. Idempotent - every insert is
 *  OR IGNORE keyed on (token, entity_id), so running it repeatedly only ever ADDS missing
 *  rows. Used by the migration (legacy backfill) and as a self-heal for entities created by
 *  a path that bypasses put()/resolve (e.g. a direct addNode). */
export function backfillEntityTokens(db: Database): void {
  const rows = db.query("SELECT id, data FROM nodes WHERE coll = 'entities'").all() as Array<{ id: string; data: string }>
  if (rows.length === 0) return
  const ins = db.query("INSERT OR IGNORE INTO entity_tokens (token, entity_id) VALUES (?, ?)")
  for (const r of rows) {
    const d = safeParseData(r.data)
    const label = d.label ?? r.id
    for (const tok of indexTokens(label, typeBucket(d.type))) ins.run(tok, r.id)
  }
}

type EdgeRow = {
  src: string
  dst: string
  label: string
  weight: number
  created_at: number
  valid_at: number | null
  invalid_at: number | null
  expired_at: number | null
  provenance: string
  confidence: number
}

export class EntityAliasRepo implements AliasStore {
  constructor(private readonly db: Database) {}

  // One-shot guard for the lazy token backfill (see ensureTokensBackfilled): after the
  // first candidate query on this instance the index is trusted to be kept current by
  // put()/upgradeLabel(), so the O(N) reconciliation runs at most once per process.
  private tokensBackfilled = false

  lookup(slug: string): { canonicalId: string } | undefined {
    const row = this.db.query("SELECT canonical_id FROM entity_aliases WHERE alias_slug = ?").get(slug) as
      | { canonical_id: string }
      | undefined
    return row ? { canonicalId: row.canonical_id } : undefined
  }

  put(slug: string, canonicalId: string, surface: string): void {
    if (!slug) return
    // First writer wins the mapping for a slug: an alias slug should stay pinned to the
    // canonical it first resolved to (INSERT OR IGNORE), so a later look-alike can't
    // silently re-point an established alias.
    this.db
      .query("INSERT OR IGNORE INTO entity_aliases (alias_slug, canonical_id, surface, created_at) VALUES (?, ?, ?, ?)")
      .run(slug, canonicalId, surface, Date.now())
    // Keep the blocking index current on the write path: index this surface's distinctive
    // tokens against the canonical, so the next variant is found by an indexed lookup.
    this.indexEntityTokens(canonicalId, surface)
  }

  // Insert the blocking tokens for `text` against `entityId` (INSERT OR IGNORE, so it
  // accumulates distinct tokens as new surface forms resolve to the same canonical).
  private indexEntityTokens(entityId: string, text: string): void {
    if (!entityId || !text) return
    const ins = this.db.query("INSERT OR IGNORE INTO entity_tokens (token, entity_id) VALUES (?, ?)")
    for (const tok of indexTokens(text)) ins.run(tok, entityId)
  }

  // Lazily reconcile the token index with the entity nodes exactly once per instance, so
  // entities introduced by a path that skips put() (a direct addNode, or pre-existing data)
  // are still blockable. After this the write path (put/upgradeLabel) maintains it.
  private ensureTokensBackfilled(): void {
    if (this.tokensBackfilled) return
    this.tokensBackfilled = true
    backfillEntityTokens(this.db)
  }

  /** Candidate canonical entities a surface form might be a variant of. Blocks on the
   *  surface's distinctive token(s) via the indexed entity_tokens table (an acronym/nickname
   *  form is a token too), then fetches those nodes - an indexed point lookup instead of the
   *  old O(N) LIKE scan over every entity. Same EntityCandidate[] return; capped. */
  candidates(surface: string, bucket: TypeBucket): EntityCandidate[] {
    this.ensureTokensBackfilled()
    const tokens = blockingTokens(surface, bucket)
    if (tokens.length === 0) return []
    // Skip HUB blocking tokens - ones carried by very many entities (e.g. every "PersonNNNN"
    // shares "person"). They're NON-discriminating: a real merge always shares a distinctive
    // token, so a hub token only floods candidate generation with up-to-LIMIT rows that never
    // match - which made resolving each new entity O(hub) and ingest O(N²). The hub test is a
    // LIMIT (hub+1) count, so it costs O(hub), not O(token-frequency). Same principle as the
    // graph hub-skip. If EVERY token is a hub, there's no discriminating key ⇒ treat as new.
    const HUB = Number(process.env.CONTEXT_ENTITY_HUB ?? 128)
    const discriminating = tokens.filter(
      (t) =>
        (this.db.query(`SELECT COUNT(*) c FROM (SELECT 1 FROM entity_tokens WHERE token = ? LIMIT ${HUB + 1})`).get(t) as { c: number }).c <= HUB,
    )
    if (discriminating.length === 0) return []
    const ph = discriminating.map(() => "?").join(",")
    const rows = this.db
      .query(
        `SELECT n.id AS id, n.data AS data
           FROM entity_tokens t JOIN nodes n ON n.id = t.entity_id
          WHERE t.token IN (${ph}) AND n.coll = 'entities'
          LIMIT 200`,
      )
      .all(...discriminating) as Array<{ id: string; data: string }>
    const out = new Map<string, EntityCandidate>()
    for (const r of rows) {
      const d = safeParseData(r.data)
      out.set(r.id, { id: r.id, label: d.label ?? r.id, type: d.type })
    }
    return [...out.values()]
  }

  /** Upgrade an entity's human label to the MORE SPECIFIC surface form (more tokens, or
   *  longer when token counts tie) and make sure the label's slug is a usable alias. Never
   *  downgrades - a later bare "Acme" won't overwrite an established "Acme Corporation". */
  upgradeLabel(canonicalId: string, surface: string): void {
    const row = this.db.query("SELECT data FROM nodes WHERE id = ?").get(canonicalId) as { data: string } | undefined
    if (!row) return
    const d = JSON.parse(row.data) as { label?: string; type?: string }
    const cur = d.label ?? ""
    const better = specificity(surface) > specificity(cur)
    const finalLabel = better ? surface : cur
    if (better) {
      this.db.query("UPDATE nodes SET data = json_set(data,'$.label', ?) WHERE id = ?").run(surface, canonicalId)
    }
    // Index the tokens of BOTH this surface and the (possibly upgraded) label, so the
    // canonical stays findable by either form regardless of which one won the label slot.
    this.indexEntityTokens(canonicalId, surface)
    if (finalLabel) this.put(slugify(finalLabel), canonicalId, finalLabel)
  }

  /** Every canonical entity (for the backfill dedupe pass). Also reconciles the token index
   *  first, since the dedupe pass generates candidates for entities that may have been added
   *  directly (bypassing put()) - this keeps that pass's blocking complete. */
  allEntities(): EntityCandidate[] {
    backfillEntityTokens(this.db)
    this.tokensBackfilled = true
    const rows = this.db.query("SELECT id, data FROM nodes WHERE coll = 'entities'").all() as Array<{ id: string; data: string }>
    return rows.map((r) => {
      const d = JSON.parse(r.data) as { label?: string; type?: string }
      return { id: r.id, label: d.label ?? r.id, type: d.type }
    })
  }

  /** Fold `loser` into `winner`: re-point every edge + memory subject_key, union the alias
   *  rows, delete the loser node. Non-destructive w.r.t. history (weights accumulate,
   *  provenance unions, a fact live on EITHER side stays live). Returns edges re-pointed. */
  mergeEntities(loser: string, winner: string): number {
    if (loser === winner) return 0
    const incident = this.db
      .query("SELECT * FROM edges WHERE src = ? OR dst = ? OR src = ? OR dst = ?")
      .all(loser, loser, winner, winner) as EdgeRow[]
    // Delete every loser-incident edge; we'll re-add them mapped onto the winner, folding
    // into any existing winner edge. (Winner rows are read too so the JS-side fold sees the
    // current state, but only loser rows are deleted+rewritten.)
    this.db.query("DELETE FROM edges WHERE src = ? OR dst = ?").run(loser, loser)
    const winnerEdges = new Map<string, EdgeRow>()
    for (const e of incident) if (e.src !== loser && e.dst !== loser) winnerEdges.set(key(e), e)
    let moved = 0
    for (const e of incident) {
      if (e.src !== loser && e.dst !== loser) continue // a pure winner edge - leave as-is
      const src = e.src === loser ? winner : e.src
      const dst = e.dst === loser ? winner : e.dst
      if (src === dst) continue // self-loop created by the merge → drop
      const k = `${src} ${dst} ${e.label}`
      const existing = winnerEdges.get(k)
      winnerEdges.set(k, existing ? foldEdge(existing, { ...e, src, dst }) : { ...e, src, dst })
      moved++
    }
    // Re-materialize every winner-incident edge (deleted loser rows + folded results).
    const upsert = this.db.query(
      `INSERT INTO edges (src, dst, label, weight, created_at, valid_at, invalid_at, expired_at, provenance, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(src, dst, label) DO UPDATE SET
         weight = excluded.weight, created_at = excluded.created_at, valid_at = excluded.valid_at,
         invalid_at = excluded.invalid_at, expired_at = excluded.expired_at,
         provenance = excluded.provenance, confidence = excluded.confidence`,
    )
    for (const e of winnerEdges.values()) {
      upsert.run(e.src, e.dst, e.label, e.weight, e.created_at, e.valid_at, e.invalid_at, e.expired_at, e.provenance, e.confidence)
    }

    // Re-point memory subject_keys (subj|pred or subj|pred|obj) that referenced the loser.
    this.remapMemorySubjects(loser, winner)

    // Union aliases + blocking tokens onto the winner, then delete the loser node. The
    // loser's tokens re-point to the winner (so the winner is now findable by them) and the
    // now-orphan loser rows are dropped, keeping the token index tight across merges.
    this.db.query("UPDATE entity_aliases SET canonical_id = ? WHERE canonical_id = ?").run(winner, loser)
    this.db.query("INSERT OR IGNORE INTO entity_tokens (token, entity_id) SELECT token, ? FROM entity_tokens WHERE entity_id = ?").run(winner, loser)
    this.db.query("DELETE FROM entity_tokens WHERE entity_id = ?").run(loser)
    const loserSlug = loser.startsWith("entity:") ? loser.slice("entity:".length) : loser
    this.put(loserSlug, winner, loserSlug)
    const loserLabel = (this.db.query("SELECT data FROM nodes WHERE id = ?").get(loser) as { data: string } | undefined)
    if (loserLabel) this.upgradeLabel(winner, (JSON.parse(loserLabel.data) as { label?: string }).label ?? loserSlug)
    this.db.query("DELETE FROM nodes WHERE id = ? AND coll = 'entities'").run(loser)
    return moved
  }

  // Rewrite subject_key entity ids loser→winner (both subject and object positions), then
  // reconcile any is_latest collision the rewrite created (two current rows for one
  // subject_key ⇒ keep the newest, retire the rest) so the "one current value" invariant
  // that recall relies on is preserved.
  private remapMemorySubjects(loser: string, winner: string): void {
    const rows = this.db
      .query("SELECT id, subject_key FROM memories WHERE subject_key LIKE ?")
      .all(`%${loser}%`) as Array<{ id: string; subject_key: string }>
    for (const r of rows) {
      const parts = r.subject_key.split("|")
      if (parts[0] === loser) parts[0] = winner
      if (parts.length === 3 && parts[2] === loser) parts[2] = winner
      const next = parts.join("|")
      if (next !== r.subject_key) this.db.query("UPDATE memories SET subject_key = ? WHERE id = ?").run(next, r.id)
    }
    const dups = this.db
      .query(
        `SELECT subject_key FROM memories WHERE is_latest = 1 AND is_forgotten = 0
         GROUP BY subject_key HAVING count(*) > 1`,
      )
      .all() as Array<{ subject_key: string }>
    for (const d of dups) {
      const keep = this.db
        .query("SELECT id FROM memories WHERE subject_key = ? AND is_latest = 1 AND is_forgotten = 0 ORDER BY updated_at DESC, version DESC LIMIT 1")
        .get(d.subject_key) as { id: string } | undefined
      if (keep) this.db.query("UPDATE memories SET is_latest = 0 WHERE subject_key = ? AND is_latest = 1 AND id != ?").run(d.subject_key, keep.id)
    }
  }
}

function key(e: EdgeRow): string {
  return `${e.src} ${e.dst} ${e.label}`
}

// Fold two edges that collapsed onto the same (src,dst,label): weights add, the earliest
// creation wins, a fact LIVE on either side stays live (expired only if both expired),
// confidence takes the max, provenance unions.
function foldEdge(a: EdgeRow, b: EdgeRow): EdgeRow {
  const live = a.expired_at === null || b.expired_at === null
  const prov = [...new Set([...(JSON.parse(a.provenance) as string[]), ...(JSON.parse(b.provenance) as string[])])]
  return {
    src: a.src,
    dst: a.dst,
    label: a.label,
    weight: a.weight + b.weight,
    created_at: Math.min(a.created_at, b.created_at),
    valid_at: minNullable(a.valid_at, b.valid_at),
    invalid_at: live ? null : maxNullable(a.invalid_at, b.invalid_at),
    expired_at: live ? null : maxNullable(a.expired_at, b.expired_at),
    provenance: JSON.stringify(prov),
    confidence: Math.max(a.confidence, b.confidence),
  }
}

function minNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.min(a, b)
}
function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.max(a, b)
}

// "Specificity" ranks label candidates: more tokens is more specific ("Sarah Chen" >
// "Sarah"); longer breaks ties. Used so the human-facing label converges upward.
function specificity(label: string): number {
  const toks = label.trim().split(/\s+/).filter(Boolean).length
  return toks * 1000 + label.length
}
