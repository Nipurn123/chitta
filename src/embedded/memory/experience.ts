// Episodic + procedural memory - the two memory kinds beyond timeless semantic facts.
//
//   • EPISODIC  = a time-anchored experience ("On 2026-07-10 I met Sarah at the Anthropic
//     office and we scoped the memory layer"). Each episode is DISTINCT - it is never
//     superseded or deduped away like a fact; instead it decays by recency. It carries the
//     EVENT time (occurred_at, a valid-time axis separate from ingestion time) and links to
//     the CANONICAL entities involved (actor_ids), so "the last time I spoke with Sarah"
//     resolves Sarah → her node → her episodes.
//   • PROCEDURAL = a learned how-to / preference ("When the user asks for code, they want
//     TypeScript, no comments"; "To deploy: bun run build then push"). It is a trigger →
//     action rule and, like a functional fact, SUPERSEDES on change (a new action for the
//     same trigger opens a new version; history kept).
//
// Both inherit the source record's ACL via virtual_record_id, exactly like semantic
// memories - so recall/forget stay permission-safe by construction.

import type { EmbeddingProvider } from "../../provider"
import type { MemoryRepo } from "../store/memories"
import { slugify } from "../extract"
import { sanitizeText } from "../../security/sanitize"

export interface ExperienceOpts {
  orgId: string
  virtualRecordId: string
  sourceRecordId: string
  /** Optional TTL (ms from now) for episodic memories; procedures never auto-expire. */
  ttlMs?: number
  /** ACL scope for procedural supersession (what the writer can see). Undefined ⇒ global. */
  scopeVids?: string[]
}

export interface EpisodeInput {
  event: string
  /** Event time - ms epoch or an ISO-ish date string; defaults to now (ingestion time). */
  occurredAt?: number | string
  /** Canonical entity ids involved (already resolved by the caller). */
  actorIds?: string[]
}

export interface ProcedureInput {
  /** The condition/trigger ("the user asks for code", "deploying"). May be empty. */
  trigger: string
  /** What to do / the preference ("use TypeScript, no comments"). */
  action: string
}

export type ExperienceAction = "created" | "updated" | "duplicate"

function newId(): string {
  return `mem:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

/** Parse an event time to ms epoch. Accepts a number (ms) or a parseable date string;
 *  falls back to now so an episode always has a place on the timeline. */
export function parseWhen(v?: number | string): number {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string") {
    const t = Date.parse(v)
    if (!Number.isNaN(t)) return t
  }
  return Date.now()
}

/** Record one episode (idempotent per record: re-ingesting the same document won't
 *  duplicate the experience). Returns whether it was newly created. */
export async function recordEpisode(
  repo: MemoryRepo,
  embeddings: EmbeddingProvider,
  ep: EpisodeInput,
  opts: ExperienceOpts,
): Promise<ExperienceAction> {
  const event = sanitizeText(ep.event).trim()
  if (!event) return "duplicate"
  const occurredAt = parseWhen(ep.occurredAt)
  // Stable, human-inspectable key: same event text + same day ⇒ same episode (dedup).
  const subjectKey = `episode|${new Date(occurredAt).toISOString().slice(0, 10)}|${slugify(event).slice(0, 48)}`
  if (repo.hasEpisode(opts.virtualRecordId, subjectKey)) return "duplicate"
  const embedding = await embeddings.embedDense(event)
  repo.insert({
    id: newId(),
    orgId: opts.orgId,
    virtualRecordId: opts.virtualRecordId,
    subjectKey,
    memory: event,
    embedding,
    kind: "episodic",
    occurredAt,
    actorIds: ep.actorIds ?? [],
    forgetAfter: opts.ttlMs ? Date.now() + opts.ttlMs : null,
    sourceRecordId: opts.sourceRecordId,
  })
  return "created"
}

/** Record one procedure (trigger → action). Supersedes the prior action for the same
 *  trigger (a new version); an identical re-assertion just refreshes recency. */
export async function recordProcedure(
  repo: MemoryRepo,
  embeddings: EmbeddingProvider,
  proc: ProcedureInput,
  opts: ExperienceOpts,
): Promise<ExperienceAction> {
  const trigger = sanitizeText(proc.trigger).trim()
  const action = sanitizeText(proc.action).trim()
  if (!action) return "duplicate"
  const subjectKey = `procedure|${slugify(trigger).slice(0, 64)}`
  const memory = trigger ? `When ${trigger}: ${action}` : action
  const current = repo.latestBySubject(subjectKey, opts.scopeVids)
  if (current && current.memory === memory) {
    repo.touch(current.id)
    return "duplicate"
  }
  const embedding = await embeddings.embedDense(memory)
  if (current) repo.markSuperseded(current.id)
  const id = newId()
  repo.insert({
    id,
    orgId: opts.orgId,
    virtualRecordId: opts.virtualRecordId,
    subjectKey,
    memory,
    embedding,
    kind: "procedural",
    version: current ? current.version + 1 : 1,
    parentId: current?.id ?? null,
    rootId: current?.root_id ?? id,
    relation: current ? "updates" : null,
    sourceRecordId: opts.sourceRecordId,
  })
  return current ? "updated" : "created"
}

/** Batch helpers - return per-action tallies (mirrors consolidateTriples). */
export async function recordEpisodes(
  repo: MemoryRepo,
  embeddings: EmbeddingProvider,
  episodes: EpisodeInput[],
  opts: ExperienceOpts,
): Promise<{ created: number; duplicate: number }> {
  const tally = { created: 0, duplicate: 0 }
  for (const ep of episodes) {
    const a = await recordEpisode(repo, embeddings, ep, opts)
    if (a === "created") tally.created++
    else tally.duplicate++
  }
  return tally
}

export async function recordProcedures(
  repo: MemoryRepo,
  embeddings: EmbeddingProvider,
  procedures: ProcedureInput[],
  opts: ExperienceOpts,
): Promise<{ created: number; updated: number; duplicate: number }> {
  const tally = { created: 0, updated: 0, duplicate: 0 }
  for (const p of procedures) {
    const a = await recordProcedure(repo, embeddings, p, opts)
    tally[a]++
  }
  return tally
}
