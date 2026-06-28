// LLM-backed knowledge extraction. Calls an OpenAI-compatible chat endpoint -
// point it at a LOCAL/sovereign model (vLLM/SGLang/Ollama) so nothing leaves the
// building. Unlike the deterministic extractor, it handles casual lowercase text
// ("i love lavanya" → Lavanya[PERSON], user -loves→ Lavanya).
//
// Thin facade: the implementation lives in ./extractors/llm and is re-exported here
// so existing imports keep resolving unchanged. Public API is preserved exactly.

export type { LlmExtractorConfig } from "./extractors/llm"
export { LlmExtractor, HybridExtractor } from "./extractors/llm"
