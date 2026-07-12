// Vector (de)serialization + hot-loop math for the brute-force path. Embeddings are
// stored as a compact little-endian Float32 BLOB (4 bytes/dim) instead of JSON TEXT:
//   • no JSON.parse per vector per query (the dominant cost of the old TEXT path),
//   • ~2-3x smaller on disk (and fewer pages to decrypt under encryption),
//   • zero-copy read as a Float32Array view straight off the SQLite buffer.
// decode() also accepts a legacy JSON-TEXT string so existing DBs keep working until
// they're rewritten as BLOB (reconcile/reindex or the next ingest does that).

export function encodeF32(v: number[] | Float32Array): Uint8Array {
  const f = v instanceof Float32Array ? v : Float32Array.from(v)
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength)
}

// Decode a stored embedding to a Float32Array. Handles both the BLOB format (Uint8Array,
// the default) and the legacy JSON-TEXT format (string) for backward compatibility.
export function decodeF32(stored: Uint8Array | ArrayBuffer | string): Float32Array {
  if (typeof stored === "string") return Float32Array.from(JSON.parse(stored) as number[])
  const u8 = stored instanceof Uint8Array ? stored : new Uint8Array(stored)
  // The buffer may not be 4-byte aligned (SQLite slabs); copy when misaligned so the
  // Float32Array view is valid, else view in place (zero-copy).
  if (u8.byteOffset % 4 === 0) return new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength >>> 2)
  return new Float32Array(u8.slice().buffer, 0, u8.byteLength >>> 2)
}

/** Dot product. For L2-normalized vectors (all our embedders normalize), dot == cosine,
 *  so we skip the per-row sqrt+division of full cosine in the inner loop. */
export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

/** L2-normalize (used to make the query vector unit-length so dot == cosine even if the
 *  provider didn't normalize). Returns a new Float32Array. */
export function normalize(v: ArrayLike<number>): Float32Array {
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i] * v[i]
  n = Math.sqrt(n) || 1
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n
  return out
}

// Bounded top-k selector: keeps only the k highest-scoring items, O(N log k)-ish with a
// tiny insertion array (k is small, ≤50), instead of scoring-then-full-sort O(N log N).
export class TopK<T> {
  private readonly items: Array<{ score: number; value: T }> = []
  private min = Infinity
  constructor(private readonly k: number) {}
  offer(score: number, value: T): void {
    if (this.items.length < this.k) {
      this.items.push({ score, value })
      if (this.items.length === this.k) this.min = Math.min(...this.items.map((i) => i.score))
      return
    }
    if (score <= this.min) return
    // replace the current minimum, then recompute it
    let mi = 0
    for (let i = 1; i < this.items.length; i++) if (this.items[i].score < this.items[mi].score) mi = i
    this.items[mi] = { score, value }
    this.min = this.items[0].score
    for (let i = 1; i < this.items.length; i++) if (this.items[i].score < this.min) this.min = this.items[i].score
  }
  /** Results sorted best-first. */
  values(): Array<{ score: number; value: T }> {
    return this.items.sort((a, b) => b.score - a.score)
  }
}
