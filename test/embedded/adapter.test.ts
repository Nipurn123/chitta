// The ai-tools adapter — turns a Chitta memory into `{ rememberMemory, recallMemory }` tool
// definitions for tool-calling agents. Verifies the tools store and retrieve through the real
// engine, and that the JSON-Schema `parameters` are well-formed. Hash embedder + rerank off ⇒
// deterministic, offline, no downloads.

import { describe, expect, test } from "bun:test"
import { Chitta } from "../../src/sdk"
import { chittaTools } from "../../src/adapters/ai-tools"

const mk = () => new Chitta({ embeddings: "hash", rerank: false })

describe("chittaTools adapter", () => {
  test("rememberMemory.execute stores and recallMemory.execute retrieves", async () => {
    const memory = mk()
    const tools = chittaTools(memory)

    const stored = await tools.rememberMemory.execute({ text: "The launch is scheduled for March 3rd." })
    expect(typeof stored.id).toBe("string")
    expect(stored.id.length).toBeGreaterThan(0)

    const hits = await tools.recallMemory.execute({ query: "when do we launch?" })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.text).toContain("March 3rd")
    expect(typeof hits[0]?.score).toBe("number")

    memory.close()
  })

  test("recallMemory honors the limit argument", async () => {
    const memory = mk()
    const tools = chittaTools(memory)
    for (const t of ["Postgres 16 is our datastore.", "Redis caches sessions.", "S3 stores blobs."]) {
      await tools.rememberMemory.execute({ text: t })
    }
    const hits = await tools.recallMemory.execute({ query: "what infrastructure do we use", limit: 1 })
    expect(hits.length).toBeLessThanOrEqual(1)
    memory.close()
  })

  test("tools expose valid JSON-Schema parameters", () => {
    const memory = mk()
    const { rememberMemory, recallMemory } = chittaTools(memory)

    expect(rememberMemory.parameters.type).toBe("object")
    expect(rememberMemory.parameters.required).toEqual(["text"])
    expect(rememberMemory.parameters.properties.text?.type).toBe("string")
    expect(typeof rememberMemory.description).toBe("string")

    expect(recallMemory.parameters.required).toEqual(["query"])
    expect(recallMemory.parameters.properties.query?.type).toBe("string")
    expect(recallMemory.parameters.properties.limit?.type).toBe("integer")

    memory.close()
  })
})
