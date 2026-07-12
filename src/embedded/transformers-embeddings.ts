// Real semantic embeddings via transformers.js (ONNX, in-process). Optional +
// lazy: the package is only imported on first use, so the project runs fine
// without it (falls back to LocalHashEmbeddings). Install to enable:
//   bun add @huggingface/transformers
// Select at runtime: CONTEXT_EMBEDDINGS=transformers [CONTEXT_EMBED_MODEL=...].

import type { EmbeddingProvider } from "../provider"

// Recommended embedders by PROFILE, so a deployment upgrades with ONE env var and automatically
// gets the right model + task-prefix + dim. The default (bge-small) is intentional and evidence-
// based: on our conversational-memory benchmark a 2× larger dense model (bge-base) moved recall
// <1% AND hurt ranking, at 2× latency - dense size is NOT the English-recall lever. But
// multilingual / on-device deployments genuinely need a different model, which this makes a
// one-liner. Explicit CONTEXT_EMBED_MODEL always wins over a profile.
const EMBED_PROFILES: Record<string, string> = {
  fast: "Xenova/bge-small-en-v1.5", // default - English, 384d, CPU-fast
  "english-large": "Xenova/bge-base-en-v1.5", // 768d, marginal on our bench (kept for choice)
  multilingual: "BAAI/bge-m3", // 1024d, 100+ languages, also emits learned-sparse (future signal)
  "on-device": "onnx-community/embeddinggemma-300m", // 256d matryoshka, Gemma, on-device tuned
}

/** Resolve the embedding model: explicit CONTEXT_EMBED_MODEL, else a CONTEXT_EMBED_PROFILE
 *  shortcut, else undefined (⇒ the TransformersEmbeddings default, bge-small). */
export function resolveEmbedModel(): string | undefined {
  const explicit = process.env.CONTEXT_EMBED_MODEL?.trim()
  if (explicit) return explicit
  const profile = process.env.CONTEXT_EMBED_PROFILE?.trim().toLowerCase()
  return profile ? EMBED_PROFILES[profile] : undefined
}

// Asymmetric models need a TASK PREFIX that differs for queries vs documents.
// EmbeddingGemma (the current best sub-500M model, +8 MTEB over bge-small) is the
// headline case; symmetric models (bge/gte) get no prefix.
function prefixesFor(model: string): { query: string; doc: string } | null {
  const m = model.toLowerCase()
  if (m.includes("embeddinggemma")) return { query: "task: search result | query: ", doc: "title: none | text: " }
  if (m.includes("e5") || m.includes("multilingual-e5")) return { query: "query: ", doc: "passage: " }
  return null
}

export class TransformersEmbeddings implements EmbeddingProvider {
  private extractor: ((text: string, opts: unknown) => Promise<{ data: ArrayLike<number> }>) | null = null
  private readonly prefix: { query: string; doc: string } | null
  // Matryoshka: truncate to CONTEXT_EMBED_DIM then re-normalize - big storage/speed
  // win at minimal quality loss. EmbeddingGemma (native 768) defaults to 256; 0 ⇒ full.
  private readonly dim: number
  constructor(private readonly model = "Xenova/bge-small-en-v1.5") {
    this.prefix = prefixesFor(model)
    const envDim = Number(process.env.CONTEXT_EMBED_DIM ?? 0) || 0
    this.dim = envDim || (model.toLowerCase().includes("embeddinggemma") ? 256 : 0)
  }

  private async pipe() {
    if (this.extractor) return this.extractor
    // Specifier typed as `string` so tsc doesn't require the optional dep to resolve.
    const spec = "@huggingface/transformers"
    const mod: any = await import(spec as string).catch(() => import("@xenova/transformers" as string))
    if (mod?.env) mod.env.allowLocalModels = false
    this.extractor = await mod.pipeline("feature-extraction", this.model)
    return this.extractor!
  }

  private async embed(text: string, kind: "query" | "doc"): Promise<number[]> {
    const ex = await this.pipe()
    const input = this.prefix ? this.prefix[kind] + text : text
    const out = await ex(input, { pooling: "mean", normalize: true })
    let v = Array.from(out.data as ArrayLike<number>)
    if (this.dim && this.dim < v.length) {
      v = v.slice(0, this.dim) // Matryoshka truncation
      let n = 0
      for (const x of v) n += x * x
      n = Math.sqrt(n) || 1
      v = v.map((x) => x / n) // re-normalize the truncated vector
    }
    return v
  }

  async embedDense(text: string): Promise<number[]> {
    return this.embed(text, "doc")
  }
  async embedQuery(text: string): Promise<number[]> {
    return this.embed(text, "query")
  }

  // No native sparse vector from this model - retrieval runs dense-only here.
  async embedSparse(): Promise<{ indices: number[]; values: number[] }> {
    return { indices: [], values: [] }
  }
}

// Default embedder: real semantic (transformers) when it can load, else the
// offline keyword-hash. The first call decides and sticks, so ingest + query in a
// session always use the SAME embedder (consistent vector space).
import { LocalHashEmbeddings } from "./local-embeddings"
export class AutoEmbeddings implements EmbeddingProvider {
  private chosen: EmbeddingProvider | null = null
  private readonly real: TransformersEmbeddings
  private readonly fallback = new LocalHashEmbeddings()
  constructor(model?: string) {
    this.real = new TransformersEmbeddings(model)
  }
  private async pick(): Promise<EmbeddingProvider> {
    if (this.chosen) return this.chosen
    try {
      await this.real.embedDense("warmup")
      this.chosen = this.real
    } catch {
      this.chosen = this.fallback // no package / offline → keyword hash
    }
    return this.chosen
  }
  async embedDense(q: string) {
    return (await this.pick()).embedDense(q)
  }
  async embedQuery(q: string) {
    const e = await this.pick()
    return e.embedQuery ? e.embedQuery(q) : e.embedDense(q)
  }
  async embedSparse(q: string) {
    return (await this.pick()).embedSparse(q)
  }
}
