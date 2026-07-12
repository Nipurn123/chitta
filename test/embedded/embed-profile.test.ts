// Embedder model resolution: an explicit repo id wins; else a friendly PROFILE maps to a
// recommended model; else the default (undefined ⇒ bge-small). Lets a deployment upgrade the
// embedder with one env var and the correct config, without touching code.

import { afterEach, describe, expect, test } from "bun:test"
import { resolveEmbedModel } from "../../src/embedded/transformers-embeddings"

const clear = () => {
  delete process.env.CONTEXT_EMBED_MODEL
  delete process.env.CONTEXT_EMBED_PROFILE
}
afterEach(clear)

describe("resolveEmbedModel", () => {
  test("default is undefined (⇒ TransformersEmbeddings default, bge-small)", () => {
    clear()
    expect(resolveEmbedModel()).toBeUndefined()
  })

  test("a profile maps to a recommended model", () => {
    clear()
    process.env.CONTEXT_EMBED_PROFILE = "multilingual"
    expect(resolveEmbedModel()).toBe("BAAI/bge-m3")
    process.env.CONTEXT_EMBED_PROFILE = "on-device"
    expect(resolveEmbedModel()).toContain("embeddinggemma")
  })

  test("an explicit CONTEXT_EMBED_MODEL wins over a profile", () => {
    clear()
    process.env.CONTEXT_EMBED_MODEL = "Xenova/gte-base"
    process.env.CONTEXT_EMBED_PROFILE = "multilingual"
    expect(resolveEmbedModel()).toBe("Xenova/gte-base")
  })

  test("an unknown profile falls through to the default", () => {
    clear()
    process.env.CONTEXT_EMBED_PROFILE = "nonsense"
    expect(resolveEmbedModel()).toBeUndefined()
  })
})
