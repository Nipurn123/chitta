// Hardening for the Chitta SDK: config validation (typed ConfigError), the onEvent observability
// hook (fires with a numeric ms + op, and a throwing handler never breaks a call), and the
// rememberMany batch helper. Hash embedder + rerank off ⇒ deterministic, offline, no downloads.

import { describe, expect, test } from "bun:test"
import { Chitta, type ChittaOptions } from "../../src/sdk"
import { ChittaError, ConfigError } from "../../src/errors"

const mk = (opts: Partial<ChittaOptions> = {}) => new Chitta({ embeddings: "hash", rerank: false, ...opts })

describe("Chitta SDK - hardening", () => {
  test("invalid embeddings string throws a ConfigError listing valid values", () => {
    let err: unknown
    try {
      new Chitta({ embeddings: "nope" as never, rerank: false })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ConfigError)
    expect(err).toBeInstanceOf(ChittaError) // subclass of the base
    expect((err as ConfigError).code).toBe("config")
    expect((err as ConfigError).message).toContain("hash") // helpful: lists the valid modes
    expect((err as ConfigError).message).toContain("transformers")
  })

  test("empty path throws a ConfigError", () => {
    expect(() => new Chitta({ embeddings: "hash", rerank: false, path: "   " })).toThrow(ConfigError)
  })

  test("valid embeddings preset does not throw", () => {
    const m = mk()
    expect(m).toBeInstanceOf(Chitta)
    m.close()
  })

  test("onEvent fires with a numeric ms and the correct op on recall", async () => {
    const events: { op: string; ms: number; count?: number }[] = []
    const m = mk({ onEvent: (e) => events.push(e) })
    await m.remember("The capital of France is Paris.")
    await m.recall("what is the capital of France")

    const recall = events.find((e) => e.op === "recall")
    expect(recall).toBeDefined()
    expect(typeof recall!.ms).toBe("number")
    expect(recall!.ms).toBeGreaterThanOrEqual(0)
    expect(typeof recall!.count).toBe("number") // result count is reported for recall
    expect(events.some((e) => e.op === "remember")).toBe(true) // remember fired too
    m.close()
  })

  test("rememberMany stores multiple and returns unique ids", async () => {
    const m = mk()
    const ids = await m.rememberMany([
      { text: "Paris is the capital of France." },
      { text: "Tokyo is the capital of Japan." },
      { text: "Cairo is the capital of Egypt." },
    ])
    expect(ids).toHaveLength(3)
    expect(ids.every((r) => typeof r.id === "string" && r.id.length > 0)).toBe(true)
    expect(new Set(ids.map((r) => r.id)).size).toBe(3) // ids are distinct

    const hits = await m.recall("capital of Japan")
    expect(hits.map((h) => h.text).join(" ")).toContain("Tokyo")
    m.close()
  })

  test("a throwing onEvent handler does NOT break recall", async () => {
    const m = mk({
      onEvent: () => {
        throw new Error("observer boom")
      },
    })
    await m.remember("The capital of France is Paris.")
    const hits = await m.recall("what is the capital of France")
    expect(hits[0]?.text).toContain("Paris") // recall still returned its results
    m.close()
  })
})
