// CONVERSATIONAL extraction (zero-token): casual first-person dialogue now fills the typed graph.
// Before this, chat ("I went to Japan", "I love hiking") matched none of the prose verb rules, so a
// whole conversation produced ZERO typed relations and the graph's cognition sat idle. These rules
// anchor first-person "I" to the turn's SPEAKER and accept a bounded lowercase object.

import { describe, expect, test } from "bun:test"
import { extractKnowledge } from "../../src/embedded/extract"

const typed = (text: string) => extractKnowledge(text).relations.filter((r) => r.type !== "relates_to").map((r) => `${r.from} ${r.type} ${r.to}`)

describe("conversational relation extraction", () => {
  test("first-person is anchored to the turn's speaker", () => {
    const rels = typed("Caroline (7 May 2023): I went to Japan and I love hiking.")
    expect(rels).toContain("caroline visited japan")
    expect(rels).toContain("caroline likes hiking")
  })

  test("objects are trimmed at clause boundaries (not over-captured)", () => {
    const rels = typed("Mel: I adopted a puppy last week. I visited Paris in March.")
    expect(rels).toContain("mel has puppy") // not "puppy last week"
    expect(rels).toContain("mel visited paris") // not "paris in march"
  })

  test("first-person needs a known speaker (no prefix ⇒ no speaker-anchored edge)", () => {
    // no "Name:" prefix → we can't attribute "I" to anyone → no conversational edge
    expect(typed("I love running.")).not.toContain("i likes running")
  })

  test("filler / pronoun objects are rejected", () => {
    const rels = typed("Sam: I love it. I like that. I hate mornings.")
    expect(rels.some((r) => r.endsWith(" it") || r.endsWith(" that"))).toBe(false)
    expect(rels).toContain("sam dislikes mornings") // a real object still lands
  })

  test("prose typed extraction is unaffected (no regression)", () => {
    const preds = new Set(extractKnowledge("Sarah Chen works at Meta. Acme acquired Globex.").relations.map((r) => r.type))
    expect(preds.has("works_at")).toBe(true)
    expect(preds.has("acquired")).toBe(true)
  })
})
