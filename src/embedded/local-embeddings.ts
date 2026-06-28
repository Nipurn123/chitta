// In-process embeddings. This deterministic hashing embedder is dependency-free
// so the embedded stack runs and tests with zero downloads. For real semantic
// quality in the single binary, swap in transformers.js / fastembed (ONNX bge-*)
// - it implements the same EmbeddingProvider interface, so nothing above changes.

import type { EmbeddingProvider } from "../provider"

const DIM = 64

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

function bucket(token: string): number {
  let h = 2166136261
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h) % DIM
}

export class LocalHashEmbeddings implements EmbeddingProvider {
  async embedDense(query: string): Promise<number[]> {
    const v = new Array(DIM).fill(0)
    for (const t of tokens(query)) v[bucket(t)] += 1
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
    return v.map((x) => x / norm)
  }

  async embedSparse(query: string): Promise<{ indices: number[]; values: number[] }> {
    const counts = new Map<number, number>()
    for (const t of tokens(query)) counts.set(bucket(t), (counts.get(bucket(t)) ?? 0) + 1)
    return { indices: [...counts.keys()], values: [...counts.values()] }
  }
}
