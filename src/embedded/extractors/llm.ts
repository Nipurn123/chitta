// LLM-backed knowledge extraction. Calls an OpenAI-compatible chat endpoint -
// point it at a LOCAL/sovereign model (vLLM/SGLang/Ollama) so nothing leaves the
// building. Unlike the deterministic extractor, it handles casual lowercase text
// ("i love lavanya" → Lavanya[PERSON], user -loves→ Lavanya).
// Re-exported from llm-extractor.ts to preserve original import paths.

import type { Extraction, ExtractedEntity, ExtractedRelation, KnowledgeExtractor, QuestionIntent } from "./types"
import { slugify } from "./text-hygiene"

export interface LlmExtractorConfig {
  endpoint: string // OpenAI-compatible base, e.g. http://localhost:8000
  model: string
  apiKey?: string
  fetchImpl?: typeof fetch
}

// Typed-triple extraction: the "code-like" structure - subject/object carry types,
// the predicate is a real verb, plus a confidence. (Per research: enhancing the LLM
// extractor beats REBEL/GLiNER/etc. for our TS stack - typed, no deps, no big models.)
const SYSTEM = [
  "You extract knowledge-graph TRIPLES from the user's text.",
  "Return ONLY a JSON object, no prose:",
  '{"triples":[{"subject":"<entity>","subjectType":"PERSON|ORG|PLACE|PRODUCT|CONCEPT|OTHER",',
  '"predicate":"<short verb>","object":"<entity>","objectType":"PERSON|ORG|PLACE|PRODUCT|CONCEPT|OTHER","confidence":0.0-1.0}]}',
  "Cover people, orgs, places, products, key concepts - INCLUDING casual lowercase text.",
  'Example: "i love lavanya" → {"subject":"user","subjectType":"PERSON","predicate":"loves","object":"Lavanya","objectType":"PERSON","confidence":0.95}.',
  "Be concise; only meaningful triples.",
].join(" ")

const INTENT_SYSTEM = [
  "Parse the user's QUESTION into a structured intent. Return ONLY JSON:",
  '{"type":"entity_lookup|relation_query|binary_relation","subject":"<noun or null>","predicate":"<verb or null>","object":"<noun or null>"}',
  'Examples: "who do I love?" → {"type":"relation_query","subject":"user","predicate":"loves","object":null};',
  '"does Lavanya work at Acme?" → {"type":"binary_relation","subject":"Lavanya","predicate":"works_at","object":"Acme"};',
  '"what is Pro?" → {"type":"entity_lookup","subject":null,"predicate":null,"object":"Pro"}.',
  'Map first-person ("I","me","my") to subject "user".',
].join(" ")

function parseJsonBlock(s: string): any {
  try {
    return JSON.parse(s)
  } catch {
    const m = s.match(/\{[\s\S]*\}/) // tolerate code fences / stray text
    if (m) return JSON.parse(m[0])
    throw new Error("LLM did not return JSON")
  }
}

// Process-wide LLM request counters (observability for LLM extraction / benchmark mode). Logged
// to stderr every CONTEXT_LLM_LOG_EVERY calls (default 25; 0 disables) so long runs are trackable.
let llmCalls = 0
let llmOk = 0
export function llmCallStats(): { calls: number; ok: number } {
  return { calls: llmCalls, ok: llmOk }
}

export class LlmExtractor implements KnowledgeExtractor {
  private readonly fetch: typeof fetch
  constructor(private readonly cfg: LlmExtractorConfig) {
    this.fetch = cfg.fetchImpl ?? fetch
  }

  private async chat(system: string, user: string): Promise<string> {
    llmCalls++
    const every = Number(process.env.CONTEXT_LLM_LOG_EVERY ?? 25)
    if (every > 0 && llmCalls % every === 0) console.error(`[llm] ${llmCalls} requests (${llmOk} ok)`)
    // A base URL (local vLLM/Ollama, e.g. http://localhost:8000) gets /v1/chat/completions
    // appended; a full endpoint that already ends in /chat/completions (e.g. Vertex AI's
    // OpenAI-compatible URL) is used verbatim.
    const base = this.cfg.endpoint.replace(/\/$/, "")
    const url = /\/chat\/completions$/.test(base) ? base : `${base}/v1/chat/completions`
    const res = await this.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.cfg.model,
        temperature: 0,
        // Thinking models (e.g. Vertex Gemini) spend output tokens on reasoning, so without a
        // generous cap the answer comes back EMPTY. Default 1024; raise via CONTEXT_LLM_MAX_TOKENS.
        max_tokens: Number(process.env.CONTEXT_LLM_MAX_TOKENS ?? 1024),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    })
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = body.choices?.[0]?.message?.content ?? ""
    if (content) llmOk++
    return content
  }

  async extract(text: string): Promise<Extraction> {
    const content = await this.chat(SYSTEM, text)
    if (!content) return { entities: [], relations: [] }

    const parsed = parseJsonBlock(content) as {
      triples?: Array<{
        subject?: string
        subjectType?: string
        predicate?: string
        object?: string
        objectType?: string
        confidence?: number
      }>
    }

    const entities: ExtractedEntity[] = []
    const seen = new Set<string>()
    const addEntity = (label?: string, type?: string) => {
      const l = (label ?? "").trim()
      if (!l) return
      const id = slugify(l)
      if (!id || seen.has(id)) return
      seen.add(id)
      entities.push({ id, label: l, type: (type ?? "CONCEPT").toUpperCase() })
    }
    for (const t of parsed.triples ?? []) {
      addEntity(t.subject, t.subjectType)
      addEntity(t.object, t.objectType)
    }
    const ids = new Set(entities.map((e) => e.id))
    const relations: ExtractedRelation[] = []
    for (const t of parsed.triples ?? []) {
      const from = slugify(t.subject ?? "")
      const to = slugify(t.object ?? "")
      if (from && to && from !== to && ids.has(from) && ids.has(to)) {
        relations.push({ from, to, type: (t.predicate ?? "relates_to").toLowerCase().replace(/\s+/g, "_"), confidence: t.confidence })
      }
    }
    return { entities, relations }
  }

  /** Parse a natural-language QUESTION into a graph-query intent (for KGQA). */
  async parseQuestionIntent(question: string): Promise<QuestionIntent | null> {
    const content = await this.chat(INTENT_SYSTEM, question)
    if (!content) return null
    try {
      const p = parseJsonBlock(content) as QuestionIntent
      if (!p?.type) return null
      return p
    } catch {
      return null
    }
  }
}

/** Run two extractors and merge (dedupe by entity id / relation pair). Used to
 *  combine deterministic + LLM for best recall. */
export class HybridExtractor implements KnowledgeExtractor {
  constructor(
    private readonly a: KnowledgeExtractor,
    private readonly b: KnowledgeExtractor,
  ) {}
  async extract(text: string): Promise<Extraction> {
    const results = await Promise.allSettled([this.a.extract(text), this.b.extract(text)])
    const entities = new Map<string, ExtractedEntity>()
    const relations = new Map<string, ExtractedRelation>()
    for (const r of results) {
      if (r.status !== "fulfilled") continue
      for (const e of r.value.entities) if (!entities.has(e.id)) entities.set(e.id, e)
      for (const rel of r.value.relations) {
        const key = [rel.from, rel.to].sort().join("|")
        if (!relations.has(key)) relations.set(key, rel)
      }
    }
    return { entities: [...entities.values()], relations: [...relations.values()] }
  }
}
