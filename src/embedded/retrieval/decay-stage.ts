// Re-rank stage: PERSONAL BOOST + MEMORY DECAY / SALIENCE.
//
// Personal boost: a multiplier on the RRF score for records the user owns.
// NB: no magnet penalty by RECORD SIZE - that wrongly punishes a record for being
// thoroughly chunked (a 20-fact news page is not a "magnet"). Flooding is handled
// structurally by the DIVERSITY CAP (≤ maxPerRecord per record in results), and BM25
// already favors the term-matching chunk over generic ones.
//
// MEMORY DECAY / SALIENCE (Generative-Agents / ACT-R): gently re-weight by recency
// × access-frequency × importance so fresh/important/often-used memories surface
// over stale ones - NEVER deletes. Records with no timestamp (legacy) stay neutral.
import type { SqliteStore } from "../sqlite-store"
import type { FusedResult } from "./fuse"

export interface DecayConfig {
  personalBoost: number
  maxPerRecord: number
  decayOn: boolean
  lambda: number
  decayFloor: number
  accessW: number
}

export function decayConfig(): DecayConfig {
  const decayOn = !/^(0|false|off)$/i.test(process.env.CONTEXT_DECAY ?? "1")
  return {
    personalBoost: Number(process.env.CONTEXT_PERSONAL_BOOST ?? 1.2),
    maxPerRecord: Number(process.env.CONTEXT_MAX_PER_RECORD ?? 2),
    decayOn,
    lambda: Math.LN2 / Math.max(1, Number(process.env.CONTEXT_DECAY_HALFLIFE_DAYS ?? 60)),
    decayFloor: Number(process.env.CONTEXT_DECAY_FLOOR ?? 0.5),
    accessW: Number(process.env.CONTEXT_DECAY_ACCESS_W ?? 0.15),
  }
}

// Mutates each merged item's `rrf` in place by personal boost + decay/salience, then
// sorts the list descending by rrf.
export function decayStage(store: SqliteStore, merged: FusedResult[], userId: string, cfg: DecayConfig): void {
  const recIds = [...new Set(merged.map((r) => r.metadata.recordId).filter(Boolean) as string[])]
  const ownerMap = new Map<string, string>()
  if (recIds.length)
    for (const row of store.db
      .query(`SELECT id, json_extract(data,'$.ownerId') o FROM nodes WHERE id IN (${recIds.map(() => "?").join(",")})`)
      .all(...recIds) as Array<{ id: string; o: string | null }>)
      if (row.o) ownerMap.set(row.id, row.o)
  const now = Date.now()
  const salience = cfg.decayOn ? store.recordSalience(recIds) : null
  for (const r of merged) {
    if (ownerMap.get(r.metadata.recordId as string) === userId) r.rrf *= cfg.personalBoost
    const s = salience?.get(r.metadata.recordId as string)
    if (s && s.lastAccessedAt > 0) {
      const ageDays = Math.max(0, (now - s.lastAccessedAt) / 86_400_000)
      const recency = Math.exp(-cfg.lambda * ageDays)
      const accessBoost = 1 + cfg.accessW * Math.log1p(s.accessCount)
      r.rrf *= (s.importance || 1) * (cfg.decayFloor + (1 - cfg.decayFloor) * recency) * accessBoost
    }
  }
  merged.sort((a, b) => b.rrf - a.rrf)
}
