// Parser tests for the real-dataset loaders (longMemEval + locomo). The real datasets are
// large external downloads we can't fetch in CI, so we validate the PARSER against small
// hand-written inline fixtures that mirror each dataset's exact on-disk JSON schema, written
// to a temp file and fed to the loader through its `path` option - the same code path a real
// dataset file would take.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { longMemEvalLoader } from "../../src/eval/datasets/longmemeval"
import { locomoLoader } from "../../src/eval/datasets/locomo"

let dir: string
const write = (name: string, data: unknown): string => {
  const p = join(dir, name)
  writeFileSync(p, JSON.stringify(data))
  return p
}
const historyIds = (items: Array<{ id: string }>) => new Set(items.map((h) => h.id))

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "chitta-loaders-"))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

// --- LongMemEval: instance = { question_*, haystack_session_ids/dates/sessions, answer_session_ids } ---
// Each session is a list of {role, content} turns; answer_session_ids are the evidence SESSIONS.
const LME_FIXTURE = [
  {
    question_id: "lme_single_1",
    question_type: "single-session-user",
    question: "What color is my car?",
    answer: "Blue",
    question_date: "2023/05/10",
    haystack_session_ids: ["s1", "s2"],
    haystack_dates: ["2023/05/01", "2023/05/08"],
    haystack_sessions: [
      [
        { role: "user", content: "I just bought a car." },
        { role: "assistant", content: "Congrats! What color?" },
      ],
      [
        { role: "user", content: "My car is blue.", has_answer: true },
        { role: "assistant", content: "Nice, blue is a great color." },
      ],
    ],
    answer_session_ids: ["s2"],
  },
  {
    question_id: "lme_multi_1",
    question_type: "multi-session",
    question: "Which city did I move to after my new job?",
    answer: "Berlin",
    haystack_session_ids: ["m1", "m2", "m3"],
    haystack_dates: ["2023/01/01", "2023/02/01", "2023/03/01"],
    haystack_sessions: [
      [{ role: "user", content: "I got a new job offer." }],
      [{ role: "user", content: "The job is at a company in Berlin." }],
      [{ role: "user", content: "I finally moved to Berlin last week." }],
    ],
    answer_session_ids: ["m1", "m3"],
  },
  {
    question_id: "lme_temporal_1",
    question_type: "temporal-reasoning",
    question: "What did I do before starting my diet?",
    answer: "Ate fast food",
    haystack_session_ids: ["t1"],
    haystack_dates: ["2022/12/01"],
    haystack_sessions: [[{ role: "user", content: "I ate fast food every day, then started a diet." }]],
    answer_session_ids: ["t1"],
  },
  {
    question_id: "lme_ku_1",
    question_type: "knowledge-update",
    question: "Where do I work now?",
    answer: "Acme",
    haystack_session_ids: ["k1", "k2"],
    haystack_dates: ["2023/06/01", "2023/09/01"],
    haystack_sessions: [
      [{ role: "user", content: "I work at Globex." }],
      [{ role: "user", content: "I switched jobs; I now work at Acme." }],
    ],
    answer_session_ids: ["k2"],
  },
  {
    // Abstention: id ends with `_abs`. Note the raw answer_session_ids is deliberately non-empty
    // to prove the loader DROPS evidence for abstention questions.
    question_id: "lme_pref_1_abs",
    question_type: "single-session-preference",
    question: "What is my favorite Martian dish?",
    answer: "This information is not mentioned.",
    haystack_session_ids: ["a1"],
    haystack_dates: ["2023/07/01"],
    haystack_sessions: [[{ role: "user", content: "I like pizza and pasta." }]],
    answer_session_ids: ["a1"],
  },
]

describe("longMemEvalLoader", () => {
  test("maps instances to cases with per-session history items", async () => {
    const ds = await longMemEvalLoader.load({ path: write("lme.json", LME_FIXTURE) })
    expect(ds.name).toBe("longmemeval")
    expect(ds.cases).toHaveLength(5)

    const single = ds.cases[0]!
    // one HistoryItem per session, id = haystack_session_ids
    expect(single.history).toHaveLength(2)
    expect(single.history.map((h) => h.id)).toEqual(["s1", "s2"])
    // turns joined with speaker labels + content preserved
    expect(single.history[0]!.text).toContain("user: I just bought a car.")
    expect(single.history[0]!.text).toContain("assistant: Congrats! What color?")
    // session timestamp carried from haystack_dates
    expect(single.history[1]!.timestamp).toBe("2023/05/08")
    // exactly one question per instance
    expect(single.questions).toHaveLength(1)
  })

  test("maps question_type -> category and resolves evidence ids", async () => {
    const ds = await longMemEvalLoader.load({ path: write("lme.json", LME_FIXTURE) })
    const byId = Object.fromEntries(ds.cases.map((c) => [c.id, c]))

    const cat = (id: string) => byId[id]!.questions[0]!.category
    expect(cat("lme_single_1")).toBe("single-hop")
    expect(cat("lme_multi_1")).toBe("multi-hop")
    expect(cat("lme_temporal_1")).toBe("temporal")
    expect(cat("lme_ku_1")).toBe("knowledge-update")
    expect(cat("lme_pref_1_abs")).toBe("abstention")

    // every evidence id resolves to a real history-item id in the same case
    for (const c of ds.cases) {
      const ids = historyIds(c.history)
      for (const q of c.questions) {
        for (const ev of q.evidenceIds) expect(ids.has(ev)).toBe(true)
      }
    }
    const multi = byId["lme_multi_1"]!.questions[0]!
    expect(multi.evidenceIds).toEqual(["m1", "m3"])
  })

  test("abstention question gets abstain:true and empty evidence", async () => {
    const ds = await longMemEvalLoader.load({ path: write("lme.json", LME_FIXTURE) })
    const abs = ds.cases.find((c) => c.id === "lme_pref_1_abs")!.questions[0]!
    expect(abs.category).toBe("abstention")
    expect(abs.abstain).toBe(true)
    expect(abs.evidenceIds).toEqual([])
    // non-abstention questions do not set abstain
    const normal = ds.cases.find((c) => c.id === "lme_single_1")!.questions[0]!
    expect(normal.abstain).toBeUndefined()
  })

  test("respects limit (caps number of cases)", async () => {
    const path = write("lme.json", LME_FIXTURE)
    expect((await longMemEvalLoader.load({ path, limit: 2 })).cases).toHaveLength(2)
    expect((await longMemEvalLoader.load({ path, limit: 0 })).cases).toHaveLength(0)
  })

  test("throws a clear error for missing / unreadable path", async () => {
    await expect(longMemEvalLoader.load({ path: undefined })).rejects.toThrow(/requires a .*path/i)
    await expect(longMemEvalLoader.load({ path: join(dir, "does-not-exist.json") })).rejects.toThrow(/not found/i)
  })
})

// --- LoCoMo: sample = { sample_id, conversation{ speaker_a/b, session_N[], session_N_date_time }, qa[] } ---
// Turn = {speaker, dia_id, text, blip_caption?}; evidence entries are dia_ids (TURN granularity).
// Sessions include session_10 to prove NUMERIC (not lexicographic) ordering. category 5 = adversarial.
const LOCOMO_FIXTURE = [
  {
    sample_id: "conv-test",
    conversation: {
      speaker_a: "Alice",
      speaker_b: "Bob",
      session_1: [
        { speaker: "Alice", dia_id: "D1:1", text: "Hi Bob, I adopted a dog named Rex." },
        {
          speaker: "Bob",
          dia_id: "D1:2",
          text: "That's great!",
          img_url: ["http://example.com/dog.jpg"],
          blip_caption: "a brown dog in a park",
        },
      ],
      session_1_date_time: "1:56 pm on 8 May, 2023",
      session_2: [
        { speaker: "Alice", dia_id: "D2:1", text: "Rex learned to fetch this week." },
        { speaker: "Bob", dia_id: "D2:2", text: "Rex is a fast learner." },
      ],
      session_2_date_time: "10:00 am on 15 May, 2023",
      // Out-of-lexical-order key: "session_10" must sort AFTER "session_2" numerically.
      session_10: [{ speaker: "Alice", dia_id: "D10:1", text: "Rex turned two years old today." }],
      session_10_date_time: "9:00 am on 8 May, 2024",
    },
    qa: [
      { question: "What is the name of Alice's dog?", answer: "Rex", evidence: ["D1:1"], category: 4 },
      {
        question: "What did Alice's dog learn after she adopted it?",
        answer: "To fetch",
        evidence: ["D1:1", "D2:1"],
        category: 1,
      },
      // Numeric answer to prove String() coercion.
      { question: "In what year was Rex born?", answer: 2022, evidence: ["D10:1"], category: 2 },
      {
        question: "What kind of owner is Alice likely to be?",
        answer: "A caring, attentive pet owner",
        evidence: ["D2:1"],
        category: 3,
      },
      // Adversarial (category 5): answer under `adversarial_answer`, evidence must be dropped.
      {
        question: "What breed of cat does Alice own?",
        adversarial_answer: "Not mentioned in the conversation",
        evidence: ["D1:1"],
        category: 5,
      },
    ],
  },
  {
    sample_id: "conv-second",
    conversation: {
      speaker_a: "Carol",
      speaker_b: "Dave",
      session_1: [{ speaker: "Carol", dia_id: "D1:1", text: "I started learning piano." }],
      session_1_date_time: "2:00 pm on 1 Jan, 2023",
    },
    qa: [{ question: "What instrument did Carol start learning?", answer: "Piano", evidence: ["D1:1"], category: 4 }],
  },
]

describe("locomoLoader", () => {
  test("maps each turn to a history item keyed by dia_id, in numeric session order", async () => {
    const ds = await locomoLoader.load({ path: write("locomo.json", LOCOMO_FIXTURE) })
    expect(ds.name).toBe("locomo")
    expect(ds.cases).toHaveLength(2)

    const c = ds.cases[0]!
    // one HistoryItem per turn (2 + 2 + 1 = 5 turns)
    expect(c.history).toHaveLength(5)
    expect(c.history.map((h) => h.id)).toEqual(["D1:1", "D1:2", "D2:1", "D2:2", "D10:1"])
    // speaker + session date carried onto each turn
    expect(c.history[0]!.speaker).toBe("Alice")
    expect(c.history[0]!.timestamp).toBe("1:56 pm on 8 May, 2023")
    expect(c.history[4]!.timestamp).toBe("9:00 am on 8 May, 2024")
    // session_10 sorts AFTER session_2 (numeric, not lexicographic)
    const idx = (id: string) => c.history.findIndex((h) => h.id === id)
    expect(idx("D10:1")).toBeGreaterThan(idx("D2:2"))
    // shared-image caption folded into the turn text
    expect(c.history[1]!.text).toContain("[shared photo: a brown dog in a park]")
  })

  test("maps category int -> QuestionCategory and resolves evidence ids", async () => {
    const ds = await locomoLoader.load({ path: write("locomo.json", LOCOMO_FIXTURE) })
    const c = ds.cases[0]!
    const cats = c.questions.map((q) => q.category)
    // qa order: category 4,1,2,3,5
    expect(cats).toEqual(["single-hop", "multi-hop", "temporal", "open-domain", "abstention"])

    // every non-abstention evidence id resolves to a real history-item id
    const ids = historyIds(c.history)
    for (const q of c.questions) {
      if (q.abstain) continue
      expect(q.evidenceIds.length).toBeGreaterThan(0)
      for (const ev of q.evidenceIds) expect(ids.has(ev)).toBe(true)
    }
    // multi-hop evidence spans two turns
    expect(c.questions[1]!.evidenceIds).toEqual(["D1:1", "D2:1"])
    // question ids are stable + unique per case
    expect(c.questions[0]!.id).toBe("conv-test_q0")
    expect(new Set(c.questions.map((q) => q.id)).size).toBe(c.questions.length)
  })

  test("coerces numeric answers to strings", async () => {
    const ds = await locomoLoader.load({ path: write("locomo.json", LOCOMO_FIXTURE) })
    const temporal = ds.cases[0]!.questions.find((q) => q.category === "temporal")!
    expect(temporal.answer).toBe("2022")
    expect(typeof temporal.answer).toBe("string")
  })

  test("adversarial (category 5) -> abstain:true, empty evidence, adversarial_answer as gold", async () => {
    const ds = await locomoLoader.load({ path: write("locomo.json", LOCOMO_FIXTURE) })
    const abs = ds.cases[0]!.questions.find((q) => q.category === "abstention")!
    expect(abs.abstain).toBe(true)
    expect(abs.evidenceIds).toEqual([])
    expect(abs.answer).toBe("Not mentioned in the conversation")
  })

  test("respects limit (caps number of cases)", async () => {
    const path = write("locomo.json", LOCOMO_FIXTURE)
    expect((await locomoLoader.load({ path, limit: 1 })).cases).toHaveLength(1)
    expect((await locomoLoader.load({ path, limit: 1 })).cases[0]!.id).toBe("conv-test")
  })

  test("throws a clear error for missing / unreadable path", async () => {
    await expect(locomoLoader.load({ path: undefined })).rejects.toThrow(/requires a .*path/i)
    await expect(locomoLoader.load({ path: join(dir, "nope.json") })).rejects.toThrow(/not found/i)
  })
})
