// Conversation-aware chunking, the per-chunk date header, and batched embedding at ingest.
import { test, expect, describe } from "bun:test"
import { chunkConversation, chunkText, withDateHeader } from "../../src/embedded/ingest"
import { buildEmbeddedContext } from "../../src/embedded/index"
import { LocalHashEmbeddings } from "../../src/embedded/local-embeddings"

const chat = [
  "alice: Can you recommend a good pizza place near the office?",
  "bob: Try Luigi's on 5th street.",
  "",
  "Note: they close at 9pm on weekdays.",
  "alice: Thanks! I booked a table for Friday.",
  "bob: Great, enjoy the margherita.",
].join("\n")

describe("conversation chunking", () => {
  test("a round (a question and its reply) is one chunk; a reply's own 'Note:' line stays in it", () => {
    const out = chunkConversation(chat)!
    expect(out).toHaveLength(2)
    expect(out[0]).toContain("alice: Can you recommend")
    expect(out[0]).toContain("Note: they close at 9pm") // not treated as a third speaker
    expect(out[1]).toStartWith("alice: Thanks!")
  })

  test("a long round is split, and every later piece is led by the round's opening line", () => {
    process.env.CONTEXT_CHUNK_TURN_CHARS = "300"
    try {
      const reply = Array.from({ length: 8 }, (_, i) => `Step ${i}: preheat the pan, add oil, and stir the onions gently.`).join("\n")
      const out = chunkConversation(`alice: How do I caramelize onions?\nbob: ${reply}\nalice: ok\nbob: good luck`)!
      const pieces = out.filter((c) => c.includes("Step"))
      expect(pieces.length).toBeGreaterThan(1)
      for (const p of pieces) expect(p.length).toBeLessThanOrEqual(300 + 50)
      for (const p of pieces.slice(1)) expect(p).toStartWith("alice: How do I caramelize onions?")
    } finally {
      delete process.env.CONTEXT_CHUNK_TURN_CHARS
    }
  })

  test("non-dialogue text, a one-turn note, and CONTEXT_CHUNK_TURNS=0 take the prose path", () => {
    expect(chunkConversation("The quarterly report shows revenue up 12%.\n\nCosts fell.")).toBeNull()
    expect(chunkConversation("alice: just one line\nbob: and one reply")).toBeNull() // < 2 turns each
    process.env.CONTEXT_CHUNK_TURNS = "0"
    try {
      expect(chunkConversation(chat)).toBeNull()
      // the prose chunker splits on the blank line, cutting the note off from the question it answers
      expect(chunkText(chat).find((c) => c.includes("Note:"))).not.toContain("recommend")
    } finally {
      delete process.env.CONTEXT_CHUNK_TURNS
    }
  })
})

describe("date header + batched embedding at ingest", () => {
  test("withDateHeader prefixes only chunks that don't already show the date", () => {
    expect(withDateHeader(["(2024-03-01): hi", "later bit"], "2024-03-01")).toEqual(["(2024-03-01): hi", "[2024-03-01] later bit"])
    expect(withDateHeader(["x"], Date.UTC(2024, 2, 1))).toEqual(["[2024-03-01] x"])
    expect(withDateHeader(["x"], undefined)).toEqual(["x"])
  })

  test("ingest stores occurredAt, heads every chunk with it, and embeds them in one batch", async () => {
    const base = new LocalHashEmbeddings()
    let batches = 0
    let singles = 0
    const embeddings = {
      embedDense: async (t: string) => (singles++, base.embedDense(t)),
      embedSparse: (t: string) => base.embedSparse(t),
      embedDenseBatch: async (ts: string[]) => (batches++, Promise.all(ts.map((t) => base.embedDense(t)))),
    }
    const ctx = buildEmbeddedContext({ path: ":memory:", embeddings })
    ctx.ingestor.registerUser("u", "o", "u@x.com", "admin")
    singles = 0 // drift probes at build time don't count
    await ctx.authorizedIngest("u", { recordId: "s1", orgId: "o", recordName: "lunch chat", text: chat, permittedPrincipals: ["u"], occurredAt: "2024-03-01" })
    const rows = ctx.store.db.query("SELECT content FROM chunks WHERE point_id LIKE 's1#%'").all() as Array<{ content: string }>
    expect(rows.length).toBe(2)
    for (const r of rows) expect(r.content).toStartWith("[2024-03-01] ")
    expect(batches).toBe(1)
    const data = JSON.parse((ctx.store.db.query("SELECT data FROM nodes WHERE id='s1'").get() as { data: string }).data)
    expect(data.occurredAt).toBe("2024-03-01")
  })
})
