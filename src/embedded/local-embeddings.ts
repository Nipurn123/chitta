// In-process embeddings. This deterministic, dependency-free embedder is the default
// (zero downloads - tests and bunx launches run offline). It is NOT a neural model, but
// it is much stronger than a plain bag-of-words hash: it also hashes CHARACTER N-GRAMS
// (so morphological variants overlap - "running"~"run", and typos degrade gracefully)
// and WORD BIGRAMS (so short phrases carry signal), with signed feature hashing to
// cancel collision bias and sublinear term weighting. For true semantic quality (real
// synonyms, paraphrase) install @huggingface/transformers and set CONTEXT_EMBEDDINGS=real
// - it implements the same EmbeddingProvider interface, so nothing above changes.

import type { EmbeddingProvider } from "../provider"

// 256 dims (vs the old 64): fewer collisions for the richer feature set. NOTE: changing
// this value changes the vector space - an existing DB self-heals via the embedder-drift
// reconcile() (it detects the dim change and reindexes).
const DIM = 256

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

// FNV-1a → unsigned 32-bit. Used both to pick a bucket and (its high bit) a sign.
function fnv(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// Signed feature hashing: bucket = h % DIM, sign = high bit → ±. Signed hashing makes
// collisions cancel in expectation instead of always adding, so the vector is cleaner.
function addFeature(v: number[], feat: string, weight: number): void {
  const h = fnv(feat)
  const idx = h % DIM
  const sign = (h & 0x80000000) !== 0 ? 1 : -1
  v[idx] += sign * weight
}

// Character n-grams of a token, padded so prefixes/suffixes are distinct features.
function charNGrams(token: string, n: number): string[] {
  const s = `#${token}#`
  if (s.length <= n) return [s]
  const out: string[] = []
  for (let i = 0; i + n <= s.length; i++) out.push(s.slice(i, i + n))
  return out
}

function embed(text: string): number[] {
  const v = new Array(DIM).fill(0)
  const toks = tokens(text)
  // Sublinear term frequency: repeated tokens shouldn't dominate (1 + log count).
  const tf = new Map<string, number>()
  for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1)
  for (const [t, c] of tf) {
    const w = 1 + Math.log(c)
    addFeature(v, `w:${t}`, w) // whole-word feature
    for (const g of charNGrams(t, 3)) addFeature(v, `c:${g}`, 0.5 * w) // morphology / fuzzy
  }
  // Word bigrams: short phrases ("new york", "machine learning") carry their own signal.
  for (let i = 0; i + 1 < toks.length; i++) addFeature(v, `b:${toks[i]}_${toks[i + 1]}`, 0.7)
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
  return v.map((x) => x / norm)
}

export class LocalHashEmbeddings implements EmbeddingProvider {
  isLexical(): boolean {
    return true // keyword feature-hashing, not a semantic space
  }
  async embedDense(query: string): Promise<number[]> {
    return embed(query)
  }

  // Symmetric: queries and documents share the same feature space (no asymmetric prefix).
  async embedQuery(query: string): Promise<number[]> {
    return embed(query)
  }

  async embedSparse(query: string): Promise<{ indices: number[]; values: number[] }> {
    const counts = new Map<number, number>()
    for (const t of tokens(query)) {
      const idx = fnv(`w:${t}`) % DIM
      counts.set(idx, (counts.get(idx) ?? 0) + 1)
    }
    return { indices: [...counts.keys()], values: [...counts.values()] }
  }
}
