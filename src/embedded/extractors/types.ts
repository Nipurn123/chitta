// Shared knowledge-extraction types. Re-exported from extract.ts to preserve the
// original import paths (`import { ExtractedEntity } from "../extract"`).

export interface ExtractedEntity {
  id: string // normalized slug (stable across docs → same concept merges)
  label: string // surface form as first seen
  type: string // ACRONYM | CONCEPT | PERSON | ORG | PLACE | PRODUCT | …
}
export interface ExtractedRelation {
  from: string // entity id
  to: string // entity id
  type: string // relates_to, or a verb from the LLM (loves, builds, …)
  confidence?: number // 0..1 (LLM-provided); deterministic omits it
}

/** Parsed intent of a question, for graph QA. */
export interface QuestionIntent {
  type: "entity_lookup" | "relation_query" | "binary_relation"
  subject?: string
  predicate?: string
  object?: string
}
export interface Extraction {
  entities: ExtractedEntity[]
  relations: ExtractedRelation[]
}

/** Pluggable extractor - deterministic (offline), LLM-backed (casual prose), or
 *  tree-sitter (code). Same Extraction shape, so ingest/rebuild don't care which.
 *  `meta` is an optional hint (filename / language) used by the code extractor;
 *  text extractors ignore it. */
export interface KnowledgeExtractor {
  extract(text: string, meta?: { name?: string; language?: string }): Promise<Extraction>
}
