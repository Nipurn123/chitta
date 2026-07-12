// The default offline embedder is dependency-free, but stronger than a plain
// bag-of-words hash: character n-grams give MORPHOLOGICAL overlap (so "running" is
// closer to "run/runner" than to an unrelated word) and word bigrams add phrase signal.
// This is what makes the zero-download default usable, not just exact-token matching.
import { test, expect, describe } from "bun:test"
import { LocalHashEmbeddings } from "../../src/embedded/local-embeddings"
import { cosine } from "../../src/embedded/retrieval/passage"

const emb = new LocalHashEmbeddings()

describe("offline embedder (hashing v2)", () => {
  test("morphological variants are closer than unrelated terms", async () => {
    const run = await emb.embedDense("running")
    const related = await emb.embedDense("runner trains daily") // shares the run- stem
    const unrelated = await emb.embedDense("quarterly budget spreadsheet")
    expect(cosine(run, related)).toBeGreaterThan(cosine(run, unrelated))
  })

  test("vectors are L2-normalized (self-similarity ≈ 1)", async () => {
    const v = await emb.embedDense("permission aware memory")
    expect(cosine(v, v)).toBeCloseTo(1, 5)
  })

  test("shared phrase (bigram) raises similarity over single-word overlap", async () => {
    const q = await emb.embedDense("machine learning research")
    const phrase = await emb.embedDense("machine learning is hard")
    const justWord = await emb.embedDense("the washing machine broke")
    expect(cosine(q, phrase)).toBeGreaterThan(cosine(q, justWord))
  })
})
