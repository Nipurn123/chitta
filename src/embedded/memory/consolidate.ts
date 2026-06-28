// Consolidation - the living-memory "engine". Turns the typed triples a record
// asserts into ATOMIC memories and decides, per fact, whether it is:
//   • NEW       - first time we've seen this subject (create v1), or an independent
//                 multi-valued fact (its own chain),
//   • DUPLICATE - the exact same fact re-asserted (just refresh recency),
//   • UPDATE    - a single-valued (functional) fact that CONTRADICTS the current one
//                 (e.g. works_at: Google → Meta) → supersede: flip the old version's
//                 is_latest, write a new version (+1) linked via the chain.
// This is Supermemory's updates/extends/derives model, but grounded in our typed-graph
// + permission model: contradictions resolve non-destructively (history kept) and the
// whole thing inherits the source record's ACL via virtual_record_id. No LLM needed -
// the calling model already supplied precise triples; an LLM extractor only enriches.

import type { EmbeddingProvider } from "../../provider"
import type { MemoryRepo, NewMemory } from "../store/memories"
import { slugify, entityId } from "../extract"
import { sanitizeText } from "../../security/sanitize"

export type MemoryAction = "created" | "updated" | "duplicate"

// Single-valued predicates: a subject has at most ONE current value, so a new value
// SUPERSEDES the old (a contradiction → a new memory version). Mirrors
// FUNCTIONAL_PREDICATES in ingest.ts (kept in sync; both describe the same semantics).
const FUNCTIONAL = new Set([
  "lives_in", "located_in", "based_in", "works_at", "employed_by", "ceo_of", "led_by",
  "born_in", "current_role", "role_is", "status_is", "owns", "owned_by", "married_to",
  "reports_to", "headquartered_in", "capital_of", "member_of",
])

// Permanent facts that should never auto-expire (TTL sweep skips is_static memories).
const STATIC = new Set(["born_in", "capital_of", "native_of", "nationality_of", "gender_of"])

export interface TripleInput {
  from: string
  to: string
  type: string
}

export interface ConsolidateOpts {
  orgId: string
  virtualRecordId: string
  sourceRecordId: string
  /** Default TTL (ms from now) for dynamic memories; omitted ⇒ no expiry. */
  ttlMs?: number
}

function newId(): string {
  return `mem:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

/** Consolidate one atomic fact into the memory store. Returns what happened. */
export async function consolidateFact(
  repo: MemoryRepo,
  embeddings: EmbeddingProvider,
  fact: { subjectKey: string; memory: string; functional: boolean; isStatic: boolean },
  opts: ConsolidateOpts,
): Promise<MemoryAction> {
  const current = repo.latestBySubject(fact.subjectKey)
  const forgetAfter = !fact.isStatic && opts.ttlMs ? Date.now() + opts.ttlMs : null

  if (!current) {
    const id = newId()
    const embedding = await embeddings.embedDense(fact.memory)
    const base: NewMemory = {
      id, orgId: opts.orgId, virtualRecordId: opts.virtualRecordId, subjectKey: fact.subjectKey,
      memory: fact.memory, embedding, isStatic: fact.isStatic, forgetAfter,
      version: 1, parentId: null, rootId: id, relation: null, sourceRecordId: opts.sourceRecordId,
    }
    repo.insert(base)
    return "created"
  }

  if (current.memory === fact.memory) {
    repo.touch(current.id) // exact re-assertion → just refresh recency
    return "duplicate"
  }

  // Different value for the same subject. For a FUNCTIONAL predicate this is a
  // contradiction → supersede with a new version. For a multi-valued predicate the
  // subject_key already includes the object, so we never reach here for those (a
  // different object is a different subject_key → "created"). Guard anyway.
  if (!fact.functional) {
    const id = newId()
    const embedding = await embeddings.embedDense(fact.memory)
    repo.insert({
      id, orgId: opts.orgId, virtualRecordId: opts.virtualRecordId, subjectKey: fact.subjectKey,
      memory: fact.memory, embedding, isStatic: fact.isStatic, forgetAfter,
      version: 1, parentId: null, rootId: id, relation: null, sourceRecordId: opts.sourceRecordId,
    })
    return "created"
  }

  const id = newId()
  const embedding = await embeddings.embedDense(fact.memory)
  repo.markSuperseded(current.id)
  repo.insert({
    id, orgId: opts.orgId, virtualRecordId: opts.virtualRecordId, subjectKey: fact.subjectKey,
    memory: fact.memory, embedding, isStatic: fact.isStatic, forgetAfter,
    version: current.version + 1, parentId: current.id, rootId: current.root_id ?? current.id,
    relation: "updates", sourceRecordId: opts.sourceRecordId,
  })
  return "updated"
}

/** Turn the typed triples a record asserts into atomic memories. Functional facts
 *  key on (subject|predicate) so a new value supersedes; multi-valued facts key on
 *  the full triple so distinct objects coexist and re-asserts dedup. Returns counts. */
export async function consolidateTriples(
  repo: MemoryRepo,
  embeddings: EmbeddingProvider,
  triples: TripleInput[],
  opts: ConsolidateOpts,
): Promise<{ created: number; updated: number; duplicate: number }> {
  const tally = { created: 0, updated: 0, duplicate: 0 }
  for (const t of triples) {
    const from = sanitizeText(t.from).trim()
    const to = sanitizeText(t.to).trim()
    const pred = (t.type || "relates_to").trim().toLowerCase().replace(/\s+/g, "_")
    if (!from || !to || !pred) continue
    const subjId = entityId(slugify(from))
    const objId = entityId(slugify(to))
    if (!subjId || !objId) continue
    const functional = FUNCTIONAL.has(pred)
    const subjectKey = functional ? `${subjId}|${pred}` : `${subjId}|${pred}|${objId}`
    const memory = `${from} ${pred.replace(/_/g, " ")} ${to}`
    const action = await consolidateFact(
      repo,
      embeddings,
      { subjectKey, memory, functional, isStatic: STATIC.has(pred) },
      opts,
    )
    tally[action]++
  }
  return tally
}
