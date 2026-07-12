// The per-path answer resolvers. Each takes the providers it needs explicitly so the
// KgqaService can orchestrate by composing them. Logic, confidences, and outputs are
// identical to the original monolithic service - this is a pure structural split.

import type { SqliteGraphProvider } from "../sqlite-graph-provider"
import type { SqliteStore } from "../sqlite-store"
import type { EmbeddingProvider } from "../../provider"
import type { KgqaResult } from "../kgqa-service"
import type { Graph } from "./types"
import { stem } from "./text"
import { PREFERENCE_PREDICATES } from "./preference"
import { predMatch } from "./predicates"
import { QUERY_STOP, narrow, linesMentioningAny } from "./select"

// Record names (ACL-scoped) that mention any of the given entities.
export function cite(
  graph: SqliteGraphProvider,
  entityIds: string[],
  _userId: string,
  _orgId: string,
  accessibleRecordIds: string[],
): string[] {
  if (entityIds.length === 0 || accessibleRecordIds.length === 0) return []
  return graph.recordsMentioning(entityIds, accessibleRecordIds).slice(0, 3)
}

export function compose(
  graph: SqliteGraphProvider,
  anchor: string,
  predicate: string,
  answerIds: string[],
  labelOf: Map<string, string>,
  userId: string,
  orgId: string,
  recordIds: string[],
  reverse = false,
): KgqaResult {
  const labels = [...new Set(answerIds)].map((id) => labelOf.get(id) ?? id)
  const anchorLabel = labelOf.get(anchor) ?? anchor
  const triple = reverse
    ? { subject: labels.join(", "), predicate, object: anchorLabel }
    : { subject: anchorLabel, predicate, object: labels.join(", ") }
  // one fact per object so multi-valued answers list cleanly (e.g. "what do I love"
  // → "you love coding", "you love Lavanya"), not a comma-run.
  const pred = predicate.replace(/_/g, " ")
  const facts = labels.map((l) => (reverse ? `${l} ${pred} ${anchorLabel}` : `${anchorLabel} ${pred} ${l}`))
  return {
    answer: labels.join(", "),
    facts,
    triple,
    citations: cite(graph, [anchor, ...answerIds], userId, orgId, recordIds),
    confidence: 0.9,
  }
}

// Binary: does (subject, predicate, object) hold?
export function binaryAnswer(
  graph: SqliteGraphProvider,
  g: Graph,
  subj: string,
  obj: string,
  predStem: string,
  predicate: string | undefined,
  labelOf: Map<string, string>,
  userId: string,
  orgId: string,
  recordIds: string[],
): KgqaResult {
  const yes = g.relations.some(
    (r) => r.from === subj && r.to === obj && predMatch(r.type, predStem),
  )
  const bAnswer = yes ? "Yes." : "No (not found in your knowledge graph)."
  return {
    answer: bAnswer,
    facts: [bAnswer],
    triple: { subject: labelOf.get(subj) ?? subj, predicate: predicate ?? "", object: labelOf.get(obj) ?? obj },
    citations: yes ? cite(graph, [subj, obj], userId, orgId, recordIds) : [],
    confidence: yes ? 0.9 : 0.5,
  }
}

// Self / preference answer: return the user's preference edges (loves/likes/…) from
// the graph. Resolves abstract self-queries ("what do I like that needs logic?")
// through the graph regardless of phrasing; the frontier LLM does the final filter.
export function preferenceAnswer(
  graph: SqliteGraphProvider,
  g: Graph,
  userId: string,
  orgId: string,
  recordIds: string[],
): KgqaResult | null {
  const labelOf = new Map(g.entities.map((e) => [e.id, e.label]))
  const isPref = (t: string) => PREFERENCE_PREDICATES.has(t) || PREFERENCE_PREDICATES.has(stem(t))
  const edges = g.relations.filter((r) => isPref(r.type))
  if (!edges.length) return null
  const facts = edges.map((r) => `${labelOf.get(r.from) ?? r.from} ${r.type.replace(/_/g, " ")} ${labelOf.get(r.to) ?? r.to}`)
  const objs = [...new Set(edges.map((r) => labelOf.get(r.to) ?? r.to))]
  const ids = [...new Set(edges.flatMap((r) => [r.from, r.to]))]
  return {
    answer: facts.join("\n"),
    facts,
    triple: { subject: "you", predicate: "prefer", object: objs.join(", ") },
    citations: cite(graph, ids, userId, orgId, recordIds),
    confidence: 0.85,
  }
}

// Predicate-anchored answer: a query naming a RELATION but no entity ("what
// partnerships exist") → all edges of the matching predicate(s). Last resort before
// vector fallback, so named-entity queries (handled by entityLookup) are unaffected.
export function predicateAnswer(
  graph: SqliteGraphProvider,
  question: string,
  g: Graph,
  userId: string,
  orgId: string,
  recordIds: string[],
): KgqaResult | null {
  const preds = [...new Set(g.relations.map((r) => r.type).filter((t) => t !== "relates_to"))]
  if (!preds.length) return null
  // Don't apply QUERY_STOP here - relational words (partnership/deal/…) are exactly
  // the high-level signal we want. The predicate HEAD is its first segment
  // ("partners_with" → "partners"), matched loosely against the query's stems.
  const qStems = [...new Set(question.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4).map(stem))]
  const hit = preds.filter((p) => {
    const head = stem(p.split("_")[0] ?? p)
    return head.length >= 4 && qStems.some((qs) => qs === head || qs.includes(head) || head.includes(qs))
  })
  if (!hit.length) return null
  const set = new Set(hit)
  const edges = g.relations.filter((r) => set.has(r.type))
  if (!edges.length) return null
  const labelOf = new Map(g.entities.map((e) => [e.id, e.label]))
  const facts = edges.map((r) => `${labelOf.get(r.from) ?? r.from} ${r.type.replace(/_/g, " ")} ${labelOf.get(r.to) ?? r.to}`)
  const ids = [...new Set(edges.flatMap((r) => [r.from, r.to]))]
  return {
    answer: facts.join("\n"),
    facts,
    triple: { subject: "", predicate: hit.join(" / "), object: "" },
    citations: cite(graph, ids, userId, orgId, recordIds),
    confidence: 0.8,
  }
}

// Entity-anchored answer (no LLM needed): if the query names a known entity,
// return the line(s)/facts about it THAT MATCH THE QUERY - a specific question
// gets the specific fact; a bare entity name gets everything.
export async function entityLookup(
  graph: SqliteGraphProvider,
  store: SqliteStore,
  embeddings: EmbeddingProvider,
  question: string,
  g: Graph,
  accessibleVids: string[],
  recordIds: string[],
  _userId: string,
  _orgId: string,
): Promise<KgqaResult | null> {
  // Anchor on the query's KNOWN terms (words that appear in some entity label),
  // not one entity node - so "Google" gathers all Google lines, and the full
  // query then decides which of them to keep.
  const qwords = question.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !QUERY_STOP.has(w))
  const entityWords = new Set<string>()
  for (const e of g.entities) for (const w of e.label.toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 3) entityWords.add(w)
  const anchors = qwords.filter((w) => w.length >= 3 && entityWords.has(w)) // incl. acronyms (SAP, IBM, UCP)
  if (anchors.length === 0) return null
  const anchorSet = new Set(anchors)

  const matchedIds = g.entities
    .filter((e) => e.label.toLowerCase().split(/[^a-z0-9]+/).some((w) => anchorSet.has(w)))
    .map((e) => e.id)
  const cites = graph.recordsMentioning(matchedIds, recordIds).slice(0, 3)
  const subject = anchors.join(", ")

  // 1) Typed facts about the matched entities (when the LLM produced predicates).
  const labelOf = new Map(g.entities.map((e) => [e.id, e.label]))
  const mset = new Set(matchedIds)
  const factLines = g.relations
    .filter((r) => (mset.has(r.from) || mset.has(r.to)) && r.type !== "relates_to")
    .map((r) => `${labelOf.get(r.from) ?? r.from} ${r.type.replace(/_/g, " ")} ${labelOf.get(r.to) ?? r.to}`)
  if (factLines.length) {
    const chosen = await narrow(embeddings, question, anchors, anchorSet, factLines)
    return { answer: chosen.join("\n"), facts: chosen, triple: { subject, predicate: "facts", object: `${chosen.length}` }, citations: cites, confidence: 0.85 }
  }

  // 2) Otherwise the exact line(s) mentioning an anchor - query-filtered.
  const all = linesMentioningAny(store, anchors, accessibleVids)
  if (all.length === 0) return null
  const lines = await narrow(embeddings, question, anchors, anchorSet, all)
  return {
    answer: lines.join("\n"),
    facts: lines,
    triple: { subject, predicate: "info", object: lines.length > 1 ? `${lines.length} facts` : lines[0] },
    citations: cites,
    confidence: 0.78,
  }
}
