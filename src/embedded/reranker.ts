// Cross-encoder reranker - the final, highest-precision retrieval stage. After RRF
// fuses BM25+dense+graph into a high-RECALL candidate pool, a cross-encoder fixes the
// ORDERING: it jointly attends over (query, passage) and scores true relevance -
// exactly the dimension rank-only RRF is weakest at (+5-15 pts ranking precision in
// 2026 benchmarks). We use the distilled ms-marco-MiniLM-L-6-v2 (~22M params) via
// transformers.js/ONNX, int8 - same in-process, no-server footprint as our embedder.
//
// OPTIONAL (like @huggingface/transformers): if the model can't load, rank() returns
// null and the caller keeps the RRF order. Never throws, never blocks retrieval.

export interface Reranker {
  /** Score each doc's relevance to the query (higher = better). null ⇒ unavailable. */
  rank(query: string, docs: string[]): Promise<number[] | null>
}

const DEFAULT_MODEL = process.env.CONTEXT_RERANK_MODEL || "Xenova/ms-marco-MiniLM-L-6-v2"

export class CrossEncoderReranker implements Reranker {
  private model: unknown | null = null
  private tokenizer: unknown | null = null
  private failed = false
  private loading: Promise<void> | null = null
  constructor(private readonly modelId: string = DEFAULT_MODEL) {}

  private async ensure(): Promise<boolean> {
    if (this.failed) return false
    if (this.model && this.tokenizer) return true
    if (!this.loading) {
      this.loading = (async () => {
        try {
          // Optional dep - indirect the specifier so tsc doesn't require it to resolve.
          const spec = "@huggingface/transformers"
          const t: any = await import(spec as string)
          this.tokenizer = await t.AutoTokenizer.from_pretrained(this.modelId)
          this.model = await t.AutoModelForSequenceClassification.from_pretrained(this.modelId, { quantized: true })
        } catch {
          this.failed = true // model unavailable (not downloaded / offline) → graceful no-op
        }
      })()
    }
    await this.loading
    return !this.failed && !!this.model
  }

  async rank(query: string, docs: string[]): Promise<number[] | null> {
    if (docs.length === 0) return []
    if (!(await this.ensure())) return null
    try {
      const tok = this.tokenizer as any
      const model = this.model as any
      // cross-encoder: each example is (query, doc) via text_pair
      const inputs = tok(new Array(docs.length).fill(query), { text_pair: docs, padding: true, truncation: true })
      const { logits } = await model(inputs)
      const data = Array.from(logits.data as Iterable<number>)
      const cols = logits.dims[logits.dims.length - 1] as number
      // relevance logit: single-logit head → that value; 2-logit → positive class.
      const out: number[] = []
      for (let i = 0; i < docs.length; i++) out.push(cols === 1 ? data[i] : data[i * cols + (cols - 1)])
      return out
    } catch {
      return null
    }
  }
}
