// Time-aware retrieval: relative time in a question ("a week ago", "last month", "in March",
// "most recently") becomes a window or a recency preference, and candidates whose content date
// fits are lifted - never filtered.
import { test, expect, describe } from "bun:test"
import { parseDate, parseTimeIntent, timeStage } from "../../src/embedded/retrieval/time-stage"
import { subQueries } from "../../src/embedded/retrieval/hybrid-retriever"
import { buildEmbeddedContext } from "../../src/embedded/index"
import type { FusedResult } from "../../src/embedded/retrieval/fuse"

const DAY = 86_400_000
const NOW = Date.UTC(2024, 4, 20) // 2024-05-20
const inWin = (q: string, t: number) => {
  const w = parseTimeIntent(q, NOW)?.window
  return !!w && t >= w[0] && t <= w[1]
}

describe("parseTimeIntent", () => {
  test("'N units ago' centres on that point", () => {
    expect(inWin("Which book did I finish a week ago?", NOW - 7 * DAY)).toBe(true)
    expect(inWin("Which book did I finish a week ago?", NOW - 30 * DAY)).toBe(false)
    expect(inWin("what did we discuss two months ago", NOW - 61 * DAY)).toBe(true)
  })
  test("'last month', 'past 3 weeks', 'yesterday', 'last Friday'", () => {
    expect(inWin("Which shoes did I clean last month?", NOW - 40 * DAY)).toBe(true)
    expect(inWin("Which shoes did I clean last month?", NOW - 90 * DAY)).toBe(false)
    expect(inWin("anything in the past 3 weeks", NOW - 20 * DAY)).toBe(true)
    expect(inWin("what did I eat yesterday", NOW - DAY)).toBe(true)
    expect(inWin("who did I meet last Friday", NOW - 4 * DAY)).toBe(true)
  })
  test("'in March' means the most recent March (or the named year)", () => {
    expect(inWin("Which airline did I fly in March?", Date.UTC(2024, 2, 15))).toBe(true)
    expect(inWin("Which airline did I fly in March?", Date.UTC(2023, 2, 15))).toBe(false)
    expect(inWin("trips in March 2023", Date.UTC(2023, 2, 15))).toBe(true)
    expect(inWin("what happened in December?", Date.UTC(2023, 11, 10))).toBe(true) // asked in May
  })
  test("'most recently' / 'lately' is a recency preference; no time words is null", () => {
    expect(parseTimeIntent("Which streaming service did I start using most recently?", NOW)).toEqual({ recent: true })
    expect(parseTimeIntent("What is my dog's name?", NOW)).toBeNull()
  })
  test("parseDate reads ms, ISO and 'YYYY/MM/DD (Day) HH:MM'", () => {
    expect(parseDate(NOW)).toBe(NOW)
    expect(parseDate("2024-05-20")).toBe(NOW)
    expect(parseDate("2023/05/20 (Sat) 02:21")).toBe(new Date(2023, 4, 20, 2, 21).getTime())
    expect(parseDate("not a date")).toBeNull()
  })
})

describe("timeStage", () => {
  test("a record dated inside the window overtakes an equal one outside it", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o", "u@x.com", "admin")
    const add = (id: string, at: number) =>
      ctx.authorizedIngest("u", { recordId: id, orgId: "o", recordName: id, text: `finished reading a novel (${id})`, permittedPrincipals: ["u"], occurredAt: at })
    await add("old", NOW - 120 * DAY)
    await add("week", NOW - 7 * DAY)
    const mk = (id: string, rrf: number) => ({ content: id, metadata: { recordId: id }, rrf, legs: new Set(["vector"]) }) as unknown as FusedResult
    const merged = [mk("old", 0.0164), mk("week", 0.0161)] // "old" slightly ahead on relevance
    timeStage(ctx.store, merged, "Which book did I finish a week ago?", NOW)
    expect(merged.map((m) => m.metadata.recordId)).toEqual(["week", "old"])
    const none = [mk("old", 0.0164), mk("week", 0.0161)]
    timeStage(ctx.store, none, "Which book did I finish?", NOW) // no time words → untouched
    expect(none.map((m) => m.metadata.recordId)).toEqual(["old", "week"])
  })
})

describe("subQueries (compound questions)", () => {
  test("a trailing 'A or B' becomes two searches", () => {
    expect(subQueries("Which did I do first, the bike service or the car wash?")).toEqual(["bike service", "car wash"])
  })
  test("quoted titles become searches; apostrophes in words are not quotes", () => {
    expect(subQueries("How long did 'Dune' and 'Emma' take me combined?")).toEqual(["Dune", "Emma"])
    expect(subQueries("What's the name of the café I've been visiting?")).toEqual([])
  })
  test("an alternative that already contains a quoted title isn't searched twice", () => {
    expect(subQueries("Which came first, the 'Python Basics' webinar or the 'SQL 101' class?")).toEqual(["Python Basics webinar", "SQL 101 class"])
  })
})

describe("LLM query expansion", () => {
  test("a memory that shares no words with the question is reached through the model's rewrite", async () => {
    const build = async (expandQuery?: (q: string) => Promise<string[]>) => {
      const ctx = buildEmbeddedContext({ path: ":memory:", llm: (expandQuery ? { expandQuery, extractFacts: async () => [], extract: async () => ({ entities: [], relations: [] }), parseQuestionIntent: async () => null } : undefined) as never })
      ctx.ingestor.registerUser("u", "o", "u@x.com", "admin")
      for (let i = 0; i < 6; i++)
        await ctx.authorizedIngest("u", { recordId: `w${i}`, orgId: "o", recordName: `w${i}`, text: `weather report: sunny afternoon number ${i}`, permittedPrincipals: ["u"] })
      await ctx.authorizedIngest("u", { recordId: "dog", orgId: "o", recordName: "dog", text: "adopted a beagle puppy named Max", permittedPrincipals: ["u"] })
      return ctx
    }
    const asked: string[] = []
    const withLlm = await build(async (q) => (asked.push(q), ["beagle puppy Max"]))
    const hit = await withLlm.searchWithGraph("weather report sunny", "u", "o", undefined, 3)
    expect(asked).toEqual(["weather report sunny"])
    expect(hit.searchResults.map((r) => r.metadata.recordId)).toContain("dog")
    const plain = await (await build()).searchWithGraph("weather report sunny", "u", "o", undefined, 3)
    expect(plain.searchResults.map((r) => r.metadata.recordId)).not.toContain("dog")
  })
})

describe("subQueries only split real compounds", () => {
  test("a single quoted title is not split off (it's already in the query)", () => {
    expect(subQueries("How many charity events did I join before the 'Run for the Cure' event?")).toEqual([])
    expect(subQueries("How long did 'Dune' and 'Emma' take me combined?")).toEqual(["Dune", "Emma"])
  })
})
