// Distinct-records-first selection: the top-k holds k DISTINCT records whenever the pool has
// that many (a record's 2nd chunk can't add a new source), and only backfills extra chunks per
// record (≤ maxPerRecord) when there aren't enough records - so a small store still returns a
// long document's second section.
import { test, expect, describe } from "bun:test"
import { diversityStage } from "../../src/embedded/retrieval/diversity"
import type { FusedResult } from "../../src/embedded/retrieval/fuse"

const mk = (rec: string, content: string, rrf: number): FusedResult =>
  ({ content, metadata: { recordId: rec, point_id: `${rec}#${content}` }, rrf, legs: new Set(["vector"]) }) as unknown as FusedResult
const recs = (out: Array<{ metadata: Record<string, unknown> }>) => out.map((r) => r.metadata.recordId)

describe("diversity stage: distinct records first", () => {
  test("a record's 2nd chunk never takes a slot another record could fill", () => {
    const ordered = [mk("A", "alpha one", 0.9), mk("A", "alpha two", 0.8), mk("B", "alpha bee", 0.7), mk("C", "alpha sea", 0.6)]
    expect(recs(diversityStage(ordered, "alpha", 0, 2, 3))).toEqual(["A", "B", "C"])
  })

  test("backfills further chunks per record (up to maxPerRecord) when records run out", () => {
    const ordered = [mk("A", "alpha one", 0.9), mk("A", "alpha two", 0.8), mk("A", "alpha three", 0.7), mk("B", "alpha bee", 0.6)]
    const out = diversityStage(ordered, "alpha", 0, 2, 5)
    expect(recs(out)).toEqual(["A", "B", "A"]) // distinct first, then A's 2nd; A's 3rd is over the cap
    expect(out.map((r) => r.content)).toEqual(["alpha one", "alpha bee", "alpha two"])
  })

  test("the relative cutoff still applies", () => {
    const ordered = [mk("A", "alpha one", 0.9), mk("B", "alpha bee", 0.1)]
    expect(recs(diversityStage(ordered, "alpha", 0.5, 2, 5))).toEqual(["A"])
  })
})
