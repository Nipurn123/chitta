// The LangChain adapter — turns a Chitta memory into a LangChain-shaped retriever and chat memory,
// with no dependency on `langchain`. Verifies the retriever emits `{ pageContent, metadata }` docs,
// that `invoke` aliases `getRelevantDocuments`, and that chat memory round-trips through `remember`
// / `recall`. Hash embedder + rerank off ⇒ deterministic, offline, no downloads.

import { describe, expect, test } from "bun:test"
import { Chitta } from "../../src/sdk"
import { chittaChatMemory, chittaRetriever } from "../../src/adapters/langchain"

const mk = () => new Chitta({ embeddings: "hash", rerank: false })

describe("chittaRetriever adapter", () => {
  test("getRelevantDocuments returns { pageContent, metadata } docs for a stored fact", async () => {
    const memory = mk()
    await memory.remember("The launch is scheduled for March 3rd.")
    const retriever = chittaRetriever(memory)

    const docs = await retriever.getRelevantDocuments("when do we launch?")
    expect(docs.length).toBeGreaterThan(0)
    const doc = docs[0]!
    expect(typeof doc.pageContent).toBe("string")
    expect(doc.pageContent).toContain("March 3rd")
    expect(typeof doc.metadata).toBe("object")
    expect(typeof doc.metadata.score).toBe("number")

    memory.close()
  })

  test("invoke aliases getRelevantDocuments", async () => {
    const memory = mk()
    await memory.remember("Our primary datastore is PostgreSQL 16.")
    const retriever = chittaRetriever(memory)

    const viaInvoke = await retriever.invoke("what database do we run?")
    const viaMethod = await retriever.getRelevantDocuments("what database do we run?")
    expect(viaInvoke.length).toBeGreaterThan(0)
    expect(viaInvoke[0]?.pageContent).toBe(viaMethod[0]?.pageContent)
    expect(viaInvoke[0]?.pageContent).toContain("PostgreSQL")

    memory.close()
  })

  test("limit option caps the number of documents", async () => {
    const memory = mk()
    for (const t of ["Postgres 16 is our datastore.", "Redis caches sessions.", "S3 stores blobs."]) {
      await memory.remember(t)
    }
    const retriever = chittaRetriever(memory, { limit: 1 })
    const docs = await retriever.getRelevantDocuments("what infrastructure do we use")
    expect(docs.length).toBeLessThanOrEqual(1)

    memory.close()
  })
})

describe("chittaChatMemory adapter", () => {
  test("saveContext + loadMemoryVariables round-trip through memory", async () => {
    const memory = mk()
    const chat = chittaChatMemory(memory)

    expect(chat.memoryKey).toBe("history")
    expect(chat.memoryKeys).toEqual(["history"])

    await chat.saveContext(
      { input: "When is the launch?" },
      { output: "The launch is scheduled for March 3rd." },
    )

    // recall chunks the stored turn, so we assert on a token present in any returned chunk of it —
    // proving the exchange was persisted by saveContext and surfaced by loadMemoryVariables.
    const vars = await chat.loadMemoryVariables({ input: "remind me about the launch" })
    expect(typeof vars.history).toBe("string")
    expect(vars.history.length).toBeGreaterThan(0)
    expect(vars.history.toLowerCase()).toContain("launch")

    memory.close()
  })

  test("loadMemoryVariables with no query returns an empty block under memoryKey", async () => {
    const memory = mk()
    const chat = chittaChatMemory(memory, { memoryKey: "chat_history" })

    const vars = await chat.loadMemoryVariables()
    expect(vars.chat_history).toBe("")

    memory.close()
  })
})
