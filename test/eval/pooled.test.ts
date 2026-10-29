// Pooled LongMemEval harness: sessions from every question pooled into ONE store (deduplicated),
// abstention questions excluded from retrieval scoring, Chitta + three baselines scored per type,
// the RRF gate computed, and an existing store protected unless --reuse.
import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadPooled, runPooled, renderPooled, scorePooled } from "../../src/eval/bench/pooled"

const turns = (user: string) => [{ role: "user", content: user }, { role: "assistant", content: "Noted." }]
const FIXTURE = [
  {
    question_id: "q_dog",
    question_type: "single-session-user",
    question: "What breed is my dog?",
    answer: "beagle",
    haystack_session_ids: ["s_dog", "s_lisbon"],
    haystack_dates: ["2023/05/01", "2023/05/02"],
    haystack_sessions: [turns("I adopted a beagle puppy named Max."), turns("I'm planning a trip to Lisbon.")],
    answer_session_ids: ["s_dog"],
  },
  {
    question_id: "q_trip",
    question_type: "multi-session",
    question: "When is my Lisbon trip and which airline did I book?",
    answer: "July, TAP",
    haystack_session_ids: ["s_lisbon", "s_flight"],
    haystack_dates: ["2023/05/02", "2023/05/09"],
    haystack_sessions: [turns("I'm planning a trip to Lisbon."), turns("I booked TAP flights to Lisbon for July.")],
    answer_session_ids: ["s_lisbon", "s_flight"],
  },
  {
    question_id: "q_salary_abs",
    question_type: "single-session-user",
    question: "What is my salary?",
    answer: "Never mentioned.",
    haystack_session_ids: ["s_gym"],
    haystack_dates: ["2023/05/03"],
    haystack_sessions: [turns("I go to the gym on Mondays.")],
    answer_session_ids: [],
  },
]

let dir: string
let path: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "chitta-pooled-"))
  path = join(dir, "lme.json")
  writeFileSync(path, JSON.stringify(FIXTURE))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("pooled LongMemEval", () => {
  test("pools each session once and scores only answerable questions", async () => {
    const data = await loadPooled(path)
    expect(data.sessions.map((s) => s.id).sort()).toEqual(["s_dog", "s_flight", "s_gym", "s_lisbon"])
    expect(data.questions.map((q) => q.id)).toEqual(["q_dog", "q_trip"]) // _abs has no gold sessions
    expect(data.questions[1].type).toBe("multi-session")
  })

  test("runs Chitta + baselines over one store and computes the gate", async () => {
    const r = await runPooled({ path, store: ":memory:", k: 3, rerank: false })
    expect(r.sessions).toBe(4)
    expect(r.rerank).toBe(false)
    const methods = new Set(r.rows.filter((x) => x.type === "ALL").map((x) => x.method))
    expect([...methods].sort()).toEqual(["bm25", "bm25+dense-rrf", "chitta", "dense"])
    expect(r.perQuestion).toHaveLength(8) // 2 questions × 4 methods
    const chitta = r.perQuestion.find((p) => p.method === "chitta" && p.id === "q_dog")!
    expect(chitta.ranked).toContain("s_dog")
    expect(r.gate.pass).toBe(r.gate.chitta >= r.gate.rrf)
    expect(renderPooled(r)).toContain("GATE")
  })

  test("refuses to overwrite an existing store unless reuse is set", async () => {
    const store = join(dir, "exists.db")
    writeFileSync(store, "")
    await expect(runPooled({ path, store, rerank: false })).rejects.toThrow(/--reuse/)
  })

  test("scoring: all-gold needs every gold session in the top k, MRR uses the first hit", () => {
    const qs = [{ id: "a", type: "t", question: "", gold: ["g1", "g2"] }]
    const results = new Map([["m", new Map([["a", { ranked: ["x", "g1", "y", "g2"], ms: 1 }]])]])
    const [row] = scorePooled(qs, results, 3)
    expect(row).toMatchObject({ type: "ALL", n: 1, allK: 0, anyK: 1, recallK: 0.5, mrr: 0.5 })
    expect(scorePooled(qs, results, 4)[0].allK).toBe(1)
  })
})

describe("pooled answer accuracy", () => {
  test("answers every question (abstention included) from both contexts and compares", async () => {
    const { runPooledQa } = await import("../../src/eval/bench/pooled-qa")
    const store = join(dir, "qa.db")
    await runPooled({ path, store, k: 3, rerank: false })
    // stub reader: answers from the context; stub judge: substring match against gold
    const llm = {
      answer: async (q: string, c: string) => (/salary/i.test(q) ? "I don't know" : c.includes("beagle") ? "beagle" : c.includes("TAP") ? "July, TAP" : "I don't know"),
      judge: async (_q: string, gold: string, p: string, o?: { abstention?: boolean }) => (o?.abstention ? /don't know/i.test(p) : p.length > 0 && gold.toLowerCase().includes(p.toLowerCase().split(",")[0])),
    }
    const r = await runPooledQa({ path, store, llm, k: 3, rerank: false, concurrency: 2 })
    expect(r.methods.map((m) => m.method)).toEqual(["chitta", "bm25+dense-rrf"])
    for (const m of r.methods) {
      expect(m.n).toBe(3) // 2 answerable + 1 abstention
      expect(m.byType.abstention).toEqual({ n: 1, correct: 1 })
    }
    expect(r.pass).toBe(r.methods[0].accuracy > r.methods[1].accuracy)
  })
})

describe("per-question harness (official shape)", () => {
  test("each question gets its own store; shards split the work; resume skips done rows; merge tables them", async () => {
    const { runPerQuestionShard, mergePerQuestion } = await import("../../src/eval/bench/per-question")
    const reader = {
      routeQuestion: async () => ({ kind: "single" as const, queries: [] }),
      complete: async (_s: string, user: string) => (user.includes("beagle") ? "NOTES: found\nANSWER: beagle" : "NOTES: none\nANSWER: I don't know"),
    }
    const judge = {
      answer: async () => "",
      judge: async (_q: string, gold: string, p: string, o?: { abstention?: boolean }) => (o?.abstention ? /don't know/i.test(p) : gold.toLowerCase().includes(p.toLowerCase())),
    }
    const outs = [join(dir, "s0.jsonl"), join(dir, "s1.jsonl")]
    const n0 = await runPerQuestionShard({ path, shard: 0, shards: 2, out: outs[0], reader, judge, rerank: false })
    const n1 = await runPerQuestionShard({ path, shard: 1, shards: 2, out: outs[1], reader, judge, rerank: false })
    expect(n0 + n1).toBe(3) // every question exactly once across shards
    expect(await runPerQuestionShard({ path, shard: 0, shards: 2, out: outs[0], reader, judge, rerank: false })).toBe(0) // resumed
    const rows = (await Promise.all(outs.map((f) => Bun.file(f).text()))).join("").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    const dog = rows.find((r) => r.id === "q_dog")!
    expect(dog).toMatchObject({ answer: "beagle", correct: true, type: "single-session-user" })
    expect(rows.find((r) => r.id === "q_salary_abs")).toMatchObject({ type: "abstention", correct: true })
    expect(mergePerQuestion(rows)).toContain("ALL")
  })
})

describe("per-question store reuse", () => {
  test("a second run reuses each question's saved store instead of re-ingesting", async () => {
    const { runPerQuestionShard } = await import("../../src/eval/bench/per-question")
    const reader = { complete: async () => "ANSWER: I don't know" }
    const judge = { answer: async () => "", judge: async () => false }
    const storeDir = join(dir, "stores")
    await runPerQuestionShard({ path, shard: 0, shards: 1, out: join(dir, "r1.jsonl"), reader, judge, rerank: false, storeDir })
    await runPerQuestionShard({ path, shard: 0, shards: 1, out: join(dir, "r2.jsonl"), reader, judge, rerank: false, storeDir })
    const rows = (await Bun.file(join(dir, "r2.jsonl")).text()).split("\n").filter(Boolean).map((l) => JSON.parse(l))
    expect(rows).toHaveLength(3)
    for (const r of rows) expect(r.ingestMs).toBe(0) // nothing ingested the second time
  })
})

describe("failed model calls are never scored", () => {
  test("no answer or no verdict writes no row; a resumed run answers it", async () => {
    const { runPerQuestionShard } = await import("../../src/eval/bench/per-question")
    let calls = 0
    const reader = { complete: async () => (++calls <= 3 ? "" : "ANSWER: beagle") } // the first pass "fails"
    const judge = { answer: async () => "", judge: async () => true }
    const out = join(dir, "flaky.jsonl")
    expect(await runPerQuestionShard({ path, shard: 0, shards: 1, out, reader, judge, rerank: false })).toBe(0)
    expect(await runPerQuestionShard({ path, shard: 0, shards: 1, out, reader, judge, rerank: false })).toBe(3)
    const noVerdict = { answer: async () => "", judge: async () => { throw new Error("judge returned no verdict") } }
    expect(await runPerQuestionShard({ path, shard: 0, shards: 1, out: join(dir, "nv.jsonl"), reader, judge: noVerdict, rerank: false })).toBe(0)
  })
})
