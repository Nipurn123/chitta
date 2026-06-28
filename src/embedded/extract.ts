// Knowledge extraction - turns raw text into entity nodes + relationship edges so
// the store becomes a real knowledge graph, not one opaque record. Deterministic
// (no LLM, no deps) so it runs offline; swap in an LLM extractor later behind the
// same `Extraction` shape for higher recall.
//
// This file is now a thin facade: the implementations live in ./extractors/* and
// are re-exported here so existing imports (`import { slugify } from "./extract"`)
// keep resolving unchanged. Public API is preserved exactly.

export type { ExtractedEntity, ExtractedRelation, QuestionIntent, Extraction, KnowledgeExtractor } from "./extractors/types"
export { slugify, entityId, ENTITY_PREFIX, cleanLine, isBoilerplate, stripBoilerplate } from "./extractors/text-hygiene"
export { DeterministicExtractor, extractKnowledge } from "./extractors/deterministic"
