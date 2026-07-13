// `ask` - the optional answer layer. Verifies the promises it makes: retrieval gathers
// numbered, deduped, belief-revised notes (zero tokens); the model sees ONLY those notes
// and the question; an empty memory answers honestly WITHOUT invoking any model; and the
// remote generator speaks real OpenAI-compatible HTTP (URL join, payload, auth header).

import { afterAll, describe, expect, test } from "bun:test"
import { buildEmbeddedContext } from "../../src/embedded/index"
import { LocalHashEmbeddings } from "../../src/embedded/local-embeddings"
import type { EmbeddingProvider } from "../../src/provider"
import {
  answerFromMemory,
  buildAskPrompt,
  gatherAskContext,
  notesAreGrounded,
  remoteAnswerer,
  resolveAnswerer,
  ensureAskModel,
  askStatus,
  type AskNote,
  type Generate,
} from "../../src/embedded/answer"

// A deterministic SEMANTIC (non-lexical) embedder: maps a text to an explicit vector, else an
// orthogonal default, so the relevance gate's cosine is fully predictable without a real model.
class VecEmbeddings implements EmbeddingProvider {
  constructor(private readonly map: Record<string, number[]>, private readonly def = [0, 0, 1]) {}
  isLexical() { return false }
  async embedDense(t: string) { return this.map[t] ?? this.def }
  async embedQuery(t: string) { return this.map[t] ?? this.def }
  async embedSparse() { return { indices: [] as number[], values: [] as number[] } }
}
const mkNotes = (texts: string[], kind: AskNote["kind"] = "fact"): AskNote[] =>
  texts.map((text, i) => ({ n: i + 1, kind, text }))

// A tiny deterministic SEMANTIC embedder: bag-of-words over a fixed vocab, L2-normalized, so
// texts sharing words have high cosine. Declares non-lexical, so it exercises the ask RANKING
// path (the hash embedder would skip ranking). Enough to prove "relevant note ranks first".
class BowEmbeddings implements EmbeddingProvider {
  private vocab = ["coding", "preference", "preferences", "user", "loves", "pirate", "talk", "texas", "musk", "lives"]
  isLexical() { return false }
  private vec(t: string): number[] {
    const words = new Set(t.toLowerCase().split(/\W+/))
    const v = this.vocab.map((w) => (words.has(w) ? 1 : 0))
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
    return v.map((x) => x / n)
  }
  async embedDense(t: string) { return this.vec(t) }
  async embedQuery(t: string) { return this.vec(t) }
  async embedSparse() { return { indices: [] as number[], values: [] as number[] } }
}

const mk = () => {
  const ctx = buildEmbeddedContext({ path: ":memory:" })
  ctx.ingestor.registerUser("u", "o", "e", "admin")
  return ctx
}

// a store with a SUPERSEDED fact: lives_in is functional, so Texas replaces California
async function muskStore() {
  const ctx = mk()
  await ctx.authorizedIngest("u", {
    recordId: "r1", orgId: "o", recordName: "musk-notes", permittedPrincipals: ["u"],
    text: "Elon Musk lives in California.",
    entities: [{ name: "Elon Musk", type: "PERSON" }, { name: "California", type: "PLACE" }],
    relations: [{ from: "Elon Musk", to: "California", type: "lives_in" }],
  })
  await ctx.authorizedIngest("u", {
    recordId: "r2", orgId: "o", recordName: "musk-update", permittedPrincipals: ["u"],
    text: "Update: Elon Musk lives in Texas now.",
    entities: [{ name: "Elon Musk", type: "PERSON" }, { name: "Texas", type: "PLACE" }],
    relations: [{ from: "Elon Musk", to: "Texas", type: "lives_in" }],
  })
  return ctx
}

describe("gatherAskContext", () => {
  test("notes are numbered 1..n, carry provenance, and reflect the CURRENT belief", async () => {
    const ctx = await muskStore()
    const notes = await gatherAskContext(ctx, "u", "o", "Where does Elon Musk live?")
    expect(notes.length).toBeGreaterThan(0)
    expect(notes.map((n) => n.n)).toEqual(notes.map((_, i) => i + 1))
    // the revised truth is present in the graph/fact layer; the superseded one is NOT
    const beliefs = notes.filter((n) => n.kind === "graph" || n.kind === "fact")
    expect(beliefs.some((n) => n.text.includes("Texas"))).toBe(true)
    expect(beliefs.some((n) => n.text.includes("California"))).toBe(false)
    // search snippets carry the source record's name
    const snip = notes.find((n) => n.kind === "snippet")
    if (snip) expect(typeof snip.name).toBe("string")
    ctx.store.close()
  })

  test("limit caps the notes and dedupe never repeats a text", async () => {
    const ctx = await muskStore()
    const notes = await gatherAskContext(ctx, "u", "o", "Elon Musk", 3)
    expect(notes.length).toBeLessThanOrEqual(3)
    const texts = notes.map((n) => n.text.toLowerCase().replace(/\s+/g, " "))
    expect(new Set(texts).size).toBe(texts.length)
    ctx.store.close()
  })

  test("ranks the RELEVANT note first regardless of source (the code-heavy-store fix)", async () => {
    // a semantic store with one on-topic record and one off-topic one
    const ctx = buildEmbeddedContext({ path: ":memory:", embeddings: new BowEmbeddings() })
    ctx.ingestor.registerUser("u", "o", "e", "admin")
    await ctx.authorizedIngest("u", { recordId: "pref", orgId: "o", recordName: "pref", permittedPrincipals: ["u"], text: "User loves coding" })
    await ctx.authorizedIngest("u", { recordId: "pirate", orgId: "o", recordName: "pirate", permittedPrincipals: ["u"], text: "Talk like a pirate" })
    const notes = await gatherAskContext(ctx, "u", "o", "coding preferences", 8)
    expect(notes.length).toBeGreaterThan(0)
    expect(notes[0].text.toLowerCase()).toContain("coding") // relevant note is #1, not the pirate noise
    // scores are populated and monotonically non-increasing (ranked, not source-ordered)
    const scores = notes.map((n) => n.score ?? -1)
    expect(scores[0]).toBeGreaterThan(0)
    expect(scores.every((s, i) => i === 0 || s <= scores[i - 1])).toBe(true)
    ctx.store.close()
  })
})

describe("answerFromMemory", () => {
  test("the model sees ONLY numbered notes + the question, and the result cites them", async () => {
    const ctx = await muskStore()
    let seenSystem = ""
    let seenUser = ""
    const streamed: string[] = []
    const fake: Generate = async (system, user, onToken) => {
      seenSystem = system
      seenUser = user
      onToken?.("Elon Musk lives in Texas [1].")
      return "Elon Musk lives in Texas [1]."
    }
    const res = await answerFromMemory(ctx, "u", "o", "Where does Elon Musk live?", fake, {
      model: "fake-model",
      onToken: (t) => streamed.push(t),
    })
    expect(res.synthesized).toBe(true)
    expect(res.model).toBe("fake-model")
    expect(res.answer).toContain("Texas")
    expect(res.sources.length).toBeGreaterThan(0)
    expect(seenSystem).toContain("ONLY")
    expect(seenUser).toContain("[1]")
    expect(seenUser).toContain("Where does Elon Musk live?")
    expect(streamed.join("")).toContain("Texas")
    ctx.store.close()
  })

  test("empty memory answers honestly and NEVER invokes the model", async () => {
    const ctx = mk()
    let called = false
    const fake: Generate = async () => {
      called = true
      return "should not run"
    }
    const res = await answerFromMemory(ctx, "u", "o", "What is the meaning of life?", fake)
    expect(called).toBe(false)
    expect(res.synthesized).toBe(false)
    expect(res.answer).toContain("don't have")
    expect(res.sources).toEqual([])
    ctx.store.close()
  })

  test("off-topic retrieval refuses WITHOUT invoking the model (the relevance gate)", async () => {
    // A populated store, but a question nothing in it is about. Force the semantic gate on (the
    // hash test embedder would skip it) and set a strict floor so the off-topic notes can't pass.
    const ctx = await muskStore()
    ;(ctx.embeddings as unknown as { isLexical: () => Promise<boolean> }).isLexical = async () => false
    const prev = process.env.CONTEXT_ASK_FLOOR
    process.env.CONTEXT_ASK_FLOOR = "0.99"
    let called = false
    const fake: Generate = async () => {
      called = true
      return "Ulaanbaatar [1]." // the exact hallucination the gate must prevent
    }
    try {
      const res = await answerFromMemory(ctx, "u", "o", "What is the capital of Mongolia?", fake)
      expect(called).toBe(false) // model never ran → cannot fabricate a citation
      expect(res.synthesized).toBe(false)
      expect(res.answer).toBe("I don't have that in memory.")
      expect(res.sources).toEqual([])
    } finally {
      if (prev === undefined) delete process.env.CONTEXT_ASK_FLOOR
      else process.env.CONTEXT_ASK_FLOOR = prev
      ctx.store.close()
    }
  })
})

describe("relevance gate (notesAreGrounded)", () => {
  test("grounded when a note aligns with the query", async () => {
    const e = new VecEmbeddings({ q: [1, 0, 0], hit: [1, 0, 0], miss: [0, 1, 0] })
    const g = await notesAreGrounded(e, "q", mkNotes(["hit", "miss"]))
    expect(g.grounded).toBe(true)
    expect(g.best).toBeCloseTo(1)
  })

  test("NOT grounded when every note is orthogonal to the query", async () => {
    const e = new VecEmbeddings({ q: [1, 0, 0], a: [0, 1, 0], b: [0, 0, 1] })
    const g = await notesAreGrounded(e, "q", mkNotes(["a", "b"]))
    expect(g.grounded).toBe(false)
    expect(g.best).toBeCloseTo(0)
  })

  test("a graph note is held to the floor too - a loose KGQA match is refused, not auto-grounded", async () => {
    const off = new VecEmbeddings({ q: [1, 0, 0], x: [0, 1, 0] }) // orthogonal → cosine 0
    expect((await notesAreGrounded(off, "q", mkNotes(["x"], "graph"))).grounded).toBe(false)
    const on = new VecEmbeddings({ q: [1, 0, 0], hit: [1, 0, 0] }) // a RELEVANT graph note still passes
    expect((await notesAreGrounded(on, "q", mkNotes(["hit"], "graph"))).grounded).toBe(true)
  })

  test("a precomputed note score is reused (no re-embedding needed)", async () => {
    // an embedder that would THROW if asked to embed - proves the score path avoids it
    const trap: EmbeddingProvider = {
      isLexical: () => false,
      embedDense: async () => { throw new Error("should not embed - score was precomputed") },
      embedQuery: async () => { throw new Error("should not embed - score was precomputed") },
      embedSparse: async () => ({ indices: [], values: [] }),
    }
    const notes: AskNote[] = [{ n: 1, kind: "snippet", text: "x", score: 0.82 }]
    expect((await notesAreGrounded(trap, "q", notes)).grounded).toBe(true)
    notes[0].score = 0.2
    expect((await notesAreGrounded(trap, "q", notes)).grounded).toBe(false)
  })

  test("the gate is skipped on a lexical (hash) embedder - no false refusals there", async () => {
    const g = await notesAreGrounded(new LocalHashEmbeddings(), "q", mkNotes(["totally unrelated"]))
    expect(g.grounded).toBe(true)
  })

  test("CONTEXT_ASK_FLOOR overrides the threshold", async () => {
    const e = new VecEmbeddings({ q: [1, 0, 0], mid: [0.7, 0.7, 0] }) // cosine ~0.707
    const prev = process.env.CONTEXT_ASK_FLOOR
    try {
      process.env.CONTEXT_ASK_FLOOR = "0.9"
      expect((await notesAreGrounded(e, "q", mkNotes(["mid"]))).grounded).toBe(false)
      process.env.CONTEXT_ASK_FLOOR = "0.5"
      expect((await notesAreGrounded(e, "q", mkNotes(["mid"]))).grounded).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.CONTEXT_ASK_FLOOR
      else process.env.CONTEXT_ASK_FLOOR = prev
    }
  })

  test("no notes → not grounded", async () => {
    expect((await notesAreGrounded(new VecEmbeddings({}), "q", [])).grounded).toBe(false)
  })
})

describe("buildAskPrompt", () => {
  test("renders numbered notes by NUMBER + text only - source labels stay out of the prompt", () => {
    const { system, user } = buildAskPrompt("q?", [
      { n: 1, kind: "fact", text: "A fact." },
      { n: 2, kind: "snippet", text: "A snippet.", name: "packages/app/notes.md" },
    ])
    expect(system.length).toBeGreaterThan(20)
    expect(user).toContain("[1] A fact.")
    expect(user).toContain("[2] A snippet.")
    expect(user).not.toContain("notes.md") // the source label is for the human footer, not the model
    expect(user).toContain("Question: q?")
  })
})

describe("citation hygiene: internal ids never reach the prompt or footer", () => {
  test("graph notes with only record-id citations carry no source name", async () => {
    // the exact shape from a real store: KGQA citations are internal record ids
    const ctx = await muskStore()
    const notes = await gatherAskContext(ctx, "u", "o", "Where does Elon Musk live?")
    for (const g of notes.filter((x) => x.kind === "graph")) {
      expect(g.name ?? "").not.toMatch(/mem-|rec-|file:/i) // no id leakage
    }
    // and so the model prompt is clean - no "(mem-…)" for it to echo into the answer
    const { user } = buildAskPrompt("q", notes)
    expect(user).not.toMatch(/mem-[a-z0-9]/i)
    ctx.store.close()
  })

  test("a real human record name IS kept", async () => {
    const ctx = mk()
    await ctx.authorizedIngest("u", {
      recordId: "r1", orgId: "o", recordName: "billing-runbook.md", permittedPrincipals: ["u"],
      text: "The billing service charges customers monthly on the 1st.",
    })
    const notes = await gatherAskContext(ctx, "u", "o", "when does billing charge?")
    expect(notes.some((x) => x.name === "billing-runbook.md")).toBe(true)
    ctx.store.close()
  })
})

describe("remote answerer (OpenAI-compatible)", () => {
  const requests: Array<{ path: string; auth: string | null; body: any }> = []
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      requests.push({
        path: new URL(req.url).pathname,
        auth: req.headers.get("authorization"),
        body: await req.json(),
      })
      return Response.json({ choices: [{ message: { content: "Gwynne Shotwell [1]." } }] })
    },
  })
  afterAll(() => server.stop(true))

  test("joins base URL to /v1/chat/completions, sends model + messages + auth, streams once", async () => {
    const a = remoteAnswerer(`http://localhost:${server.port}`, "test-model", "sk-test")
    expect(a.kind).toBe("remote")
    const chunks: string[] = []
    const out = await a.generate("sys", "usr", (t) => chunks.push(t))
    expect(out).toBe("Gwynne Shotwell [1].")
    expect(chunks).toEqual(["Gwynne Shotwell [1]."])
    const r = requests.at(-1)!
    expect(r.path).toBe("/v1/chat/completions")
    expect(r.auth).toBe("Bearer sk-test")
    expect(r.body.model).toBe("test-model")
    expect(r.body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "usr" },
    ])
  })

  test("a full .../chat/completions endpoint is used verbatim", async () => {
    const a = remoteAnswerer(`http://localhost:${server.port}/v1/chat/completions`, "m")
    await a.generate("s", "u")
    expect(requests.at(-1)!.path).toBe("/v1/chat/completions")
  })

  test("resolveAnswerer prefers CONTEXT_LLM_URL when set (no model download)", async () => {
    const prev = process.env.CONTEXT_LLM_URL
    process.env.CONTEXT_LLM_URL = `http://localhost:${server.port}`
    try {
      const a = await resolveAnswerer()
      expect(a.kind).toBe("remote")
    } finally {
      if (prev === undefined) delete process.env.CONTEXT_LLM_URL
      else process.env.CONTEXT_LLM_URL = prev
    }
  })

  test("a non-2xx endpoint fails loudly, not with an empty answer", async () => {
    const bad = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 500 }) })
    try {
      const a = remoteAnswerer(`http://localhost:${bad.port}`)
      await expect(a.generate("s", "u")).rejects.toThrow("HTTP 500")
    } finally {
      bad.stop(true)
    }
  })
})

describe("local model plumbing (no download in tests)", () => {
  test("an explicit missing .gguf path fails with a clear message", async () => {
    await expect(ensureAskModel("/definitely/not/here.gguf")).rejects.toThrow("ask model not found")
  })

  test("an existing file path is used as-is", async () => {
    const p = `${import.meta.dir}/ask.test.ts` // any existing file proves the path branch
    expect(await ensureAskModel(p)).toBe(p)
  })

  test("askStatus reports the remote endpoint when CONTEXT_LLM_URL is set", () => {
    const prev = process.env.CONTEXT_LLM_URL
    process.env.CONTEXT_LLM_URL = "http://localhost:9999"
    try {
      const st = askStatus()
      expect(st.ready).toBe(true)
      expect(st.detail).toContain("remote")
    } finally {
      if (prev === undefined) delete process.env.CONTEXT_LLM_URL
      else process.env.CONTEXT_LLM_URL = prev
    }
  })
})
