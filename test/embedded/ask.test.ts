// `ask` - the optional answer layer. Verifies the promises it makes: retrieval gathers
// numbered, deduped, belief-revised notes (zero tokens); the model sees ONLY those notes
// and the question; an empty memory answers honestly WITHOUT invoking any model; and the
// remote generator speaks real OpenAI-compatible HTTP (URL join, payload, auth header).

import { afterAll, describe, expect, test } from "bun:test"
import { buildEmbeddedContext } from "../../src/embedded/index"
import {
  answerFromMemory,
  buildAskPrompt,
  gatherAskContext,
  remoteAnswerer,
  resolveAnswerer,
  ensureAskModel,
  askStatus,
  type Generate,
} from "../../src/embedded/answer"

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
})

describe("buildAskPrompt", () => {
  test("renders numbered notes with source names", () => {
    const { system, user } = buildAskPrompt("q?", [
      { n: 1, kind: "fact", text: "A fact." },
      { n: 2, kind: "snippet", text: "A snippet.", name: "notes.md" },
    ])
    expect(system.length).toBeGreaterThan(20)
    expect(user).toContain("[1] A fact.")
    expect(user).toContain("[2] (notes.md) A snippet.")
    expect(user).toContain("Question: q?")
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
