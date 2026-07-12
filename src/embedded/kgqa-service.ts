// KGQA - answer a question with the EXACT fact from the typed graph, not a ranked
// list. "who do I love" → resolve (user, loves, ?) → "Lavanya", cited. Falls back
// to null (→ vector retrieval) when it can't answer confidently.
//
// Works best when the graph has TYPED predicate edges (from the LLM triple
// extractor). Intent parsing prefers the LLM; a small heuristic covers the
// no-LLM case for simple "who/what do I <verb>" questions.
//
// This module is the ORCHESTRATOR: the actual resolvers live under ./kgqa/* and are
// composed here. Public API (KgqaResult, KgqaService) is unchanged.

import type { SqliteGraphProvider } from "./sqlite-graph-provider"
import type { SqliteStore } from "./sqlite-store"
import type { LlmExtractor } from "./llm-extractor"
import type { EmbeddingProvider } from "../provider"
import type { QuestionIntent } from "./extract"
import { stem } from "./kgqa/text"
import type { Graph } from "./kgqa/types"
import { heuristicIntent } from "./kgqa/intent"
import { isSelfPreference } from "./kgqa/preference"
import { predMatch } from "./kgqa/predicates"
import { link } from "./kgqa/entity-link"
import {
  compose,
  binaryAnswer,
  preferenceAnswer,
  predicateAnswer,
  entityLookup,
} from "./kgqa/answer-paths"

export interface KgqaResult {
  answer: string
  /** The individual facts that make up the answer - a query can match SEVERAL typed
   *  facts (e.g. "Google limits Meta" AND "Meta uses Gemini"); each is its own item so
   *  callers/UI can list them instead of running them together. */
  facts: string[]
  triple: { subject: string; predicate: string; object: string }
  citations: string[] // record names supporting the answer
  confidence: number
}

export class KgqaService {
  constructor(
    private readonly graph: SqliteGraphProvider,
    private readonly store: SqliteStore,
    private readonly embeddings: EmbeddingProvider,
    private readonly llm?: LlmExtractor,
  ) {}

  async answer(question: string, userId: string, orgId: string): Promise<KgqaResult | null> {
    // ACL-scoped graph: only entities/relations from records this user may see.
    const accessible = await this.graph.getAccessibleVirtualRecordIds({ userId, orgId })
    const recordIds = [...new Set(Object.values(accessible))]
    const g = this.graph.getKnowledgeGraph(recordIds) as Graph
    if (g.entities.length === 0) return null
    const labelOf = new Map(g.entities.map((e) => [e.id, e.label]))

    const intent = (await this.llm?.parseQuestionIntent(question)) ?? heuristicIntent(question)
    // No relational intent? Route through the intelligent graph fallback (self/
    // preference → entity anchor → predicate anchor) before any vector search.
    if (!intent) return this.graphFallback(question, g, Object.keys(accessible), recordIds, userId, orgId)

    const subj = intent.subject ? link(intent.subject, g) : null
    const obj = intent.object ? link(intent.object, g) : null
    const predStem = intent.predicate ? stem(intent.predicate.replace(/\s+/g, "_")) : null

    // Forward relation: (subject, predicate, ?)
    if (intent.type === "relation_query" && subj && predStem && !obj) {
      const objs = g.relations.filter((r) => r.from === subj && predMatch(r.type, predStem)).map((r) => r.to)
      if (objs.length) return compose(this.graph, subj, intent.predicate!, objs, labelOf, userId, orgId, recordIds)
    }
    // Reverse relation: (?, predicate, object)
    if (intent.type === "relation_query" && obj && predStem && !subj) {
      const subs = g.relations.filter((r) => r.to === obj && predMatch(r.type, predStem)).map((r) => r.from)
      if (subs.length) return compose(this.graph, obj, intent.predicate!, subs, labelOf, userId, orgId, recordIds, true)
    }
    // Binary: does (subject, predicate, object) hold?
    if (intent.type === "binary_relation" && subj && obj && predStem) {
      return binaryAnswer(this.graph, g, subj, obj, predStem, intent.predicate, labelOf, userId, orgId, recordIds)
    }
    // Relational paths didn't resolve → intelligent graph fallback, else vector.
    return this.graphFallback(question, g, Object.keys(accessible), recordIds, userId, orgId)
  }

  // Intelligent graph routing (LightRAG dual-level): self/preference theme → entity
  // anchor → predicate anchor → null (after which the MCP falls back to vector search).
  private async graphFallback(
    question: string,
    g: Graph,
    accessibleVids: string[],
    recordIds: string[],
    userId: string,
    orgId: string,
  ): Promise<KgqaResult | null> {
    if (isSelfPreference(question)) {
      const p = preferenceAnswer(this.graph, g, userId, orgId, recordIds)
      if (p) return p
    }
    const e = await this.entityLookup(question, g, accessibleVids, recordIds, userId, orgId)
    if (e) return e
    return predicateAnswer(this.graph, question, g, userId, orgId, recordIds)
  }

  // Entity-anchored answer (no LLM needed): if the query names a known entity,
  // return the line(s)/facts about it THAT MATCH THE QUERY - a specific question
  // gets the specific fact; a bare entity name gets everything.
  entityLookup(
    question: string,
    g: Graph,
    accessibleVids: string[],
    recordIds: string[],
    userId: string,
    orgId: string,
  ): Promise<KgqaResult | null> {
    return entityLookup(this.graph, this.store, this.embeddings, question, g, accessibleVids, recordIds, userId, orgId)
  }

  // Parse a question into a typed intent - LLM-preferred with a heuristic fallback.
  async parseQuestionIntent(question: string): Promise<QuestionIntent | null> {
    return (await this.llm?.parseQuestionIntent(question)) ?? heuristicIntent(question)
  }
}
