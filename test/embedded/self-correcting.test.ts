// Self-correcting memory - the store maintains its own truth: importance scoring at write,
// confidence-aware belief revision, semantic (antonym/negation) contradiction detection, and
// a sleep-time consolidation pass that dedupes + retires + re-weights by corroboration.

import { describe, expect, test } from "bun:test"
import { buildEmbeddedContext, type EmbeddedContext } from "../../src/embedded/index"
import { computeImportance } from "../../src/embedded/ingest"
import { antonymPredicates } from "../../src/embedded/memory/contradiction"

function importanceOf(ctx: EmbeddedContext, recordId: string): number {
  const row = ctx.store.db.query("SELECT data FROM nodes WHERE id = ?").get(recordId) as { data: string }
  return (JSON.parse(row.data) as { importance: number }).importance
}

describe("importance scoring at write", () => {
  test("consequential, entity-dense records score higher than trivial ones", () => {
    const trivial = computeImportance({ recordId: "a", orgId: "o", recordName: "n", text: "the sky is blue today" })
    const weighty = computeImportance({
      recordId: "b", orgId: "o", recordName: "n",
      text: "We signed the acquisition contract; this is a critical strategic decision.",
      entities: [{ name: "Acme" }, { name: "Globex" }],
      relations: [{ from: "Acme", to: "Globex", type: "acquired" }],
    })
    expect(weighty).toBeGreaterThan(trivial)
    expect(trivial).toBeGreaterThanOrEqual(0.5)
    expect(weighty).toBeLessThanOrEqual(3)
  })
})

describe("confidence-aware belief revision", () => {
  test("a low-confidence claim cannot overwrite a high-confidence belief", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o")
    await ctx.ingestor.ingest({
      recordId: "r1", orgId: "o", recordName: "Fact", text: "x", permittedPrincipals: ["u"],
      entities: [{ name: "Acme", type: "ORG" }, { name: "Berlin", type: "PLACE" }],
      relations: [{ from: "Acme", to: "Berlin", type: "headquartered_in", confidence: 0.95 }],
    })
    // A weak rumor says Paris - it must NOT overwrite the confident Berlin belief.
    await ctx.ingestor.ingest({
      recordId: "r2", orgId: "o", recordName: "Rumor", text: "x", permittedPrincipals: ["u"],
      entities: [{ name: "Acme", type: "ORG" }, { name: "Paris", type: "PLACE" }],
      relations: [{ from: "Acme", to: "Paris", type: "headquartered_in", confidence: 0.3 }],
    })
    let mems = (await ctx.recallMemories("where is Acme based", "u", "o")).map((m) => m.memory).join(" ")
    expect(mems).toContain("Berlin")
    expect(mems).not.toContain("Paris")

    // A confident correction DOES supersede.
    await ctx.ingestor.ingest({
      recordId: "r3", orgId: "o", recordName: "Correction", text: "x", permittedPrincipals: ["u"],
      entities: [{ name: "Acme", type: "ORG" }, { name: "Munich", type: "PLACE" }],
      relations: [{ from: "Acme", to: "Munich", type: "headquartered_in", confidence: 0.99 }],
    })
    mems = (await ctx.recallMemories("where is Acme based", "u", "o")).map((m) => m.memory).join(" ")
    expect(mems).toContain("Munich")
    expect(mems).not.toContain("Berlin")
  })
})

describe("semantic contradiction (antonym / negation)", () => {
  test("antonymPredicates knows opposites and polarity flips", () => {
    expect(antonymPredicates("likes")).toContain("dislikes")
    expect(antonymPredicates("likes")).toContain("no_longer_likes")
    expect(antonymPredicates("no_longer_likes")).toContain("likes")
    // no explicit antonym → only polarity flips (so an explicit "no_longer_partners_with"
    // still retires "partners_with"), but it never invents an unrelated opposite.
    expect(antonymPredicates("partners_with")).toEqual(["not_partners_with", "no_longer_partners_with"])
  })

  test("an opposite-polarity fact retires the older belief (functional supersession can't)", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o")
    await ctx.ingestor.ingest({
      recordId: "r1", orgId: "o", recordName: "Pref", text: "x", permittedPrincipals: ["u"],
      entities: [{ name: "Sarah", type: "PERSON" }, { name: "coffee", type: "CONCEPT" }],
      relations: [{ from: "Sarah", to: "coffee", type: "likes" }],
    })
    expect((await ctx.recallMemories("Sarah coffee", "u", "o")).map((m) => m.memory).join(" ")).toContain("Sarah likes coffee")

    await ctx.ingestor.ingest({
      recordId: "r2", orgId: "o", recordName: "Pref2", text: "x", permittedPrincipals: ["u"],
      entities: [{ name: "Sarah", type: "PERSON" }, { name: "coffee", type: "CONCEPT" }],
      relations: [{ from: "Sarah", to: "coffee", type: "dislikes" }],
    })
    const mems = (await ctx.recallMemories("Sarah coffee", "u", "o")).map((m) => m.memory)
    expect(mems.some((m) => m.includes("dislikes"))).toBe(true)
    expect(mems.some((m) => m === "Sarah likes coffee")).toBe(false) // the old belief is retired
  })
})

describe("sleep-time consolidation", () => {
  test("one pass dedupes entities, sweeps, and re-weights by corroboration; idempotent", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o")
    // Two records both mention Acme (corroboration), plus a duplicate-entity pair to fold.
    await ctx.ingestor.ingest({
      recordId: "r1", orgId: "o", recordName: "A", text: "x", permittedPrincipals: ["u"],
      entities: [{ name: "Acme", type: "ORG" }], relations: [],
    })
    await ctx.ingestor.ingest({
      recordId: "r2", orgId: "o", recordName: "B", text: "x", permittedPrincipals: ["u"],
      entities: [{ name: "Acme", type: "ORG" }], relations: [],
    })
    ctx.store.addNode("entity:ibm", "entities", { label: "IBM", type: "ORG" })
    ctx.store.addNode("entity:international-business-machines", "entities", { label: "International Business Machines", type: "ORG" })

    const before = importanceOf(ctx, "r1")
    const report = ctx.sleep()
    expect(report.entitiesMerged).toBe(1) // IBM ↔ International Business Machines
    expect(importanceOf(ctx, "r1")).toBeGreaterThan(before) // Acme corroborated by r2 → boosted

    const second = ctx.sleep() // idempotent: nothing left to do
    expect(second.entitiesMerged).toBe(0)
    expect(second.recordsReweighted).toBe(0)
  })
})

describe("permission-scoped belief revision (multiple users, one org DB)", () => {
  test("one user's private update does NOT clobber another user's private memory", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("alice", "acme")
    ctx.ingestor.registerUser("bob", "acme")
    // Alice privately: her contact Sarah works at Meta. Bob privately: HIS Sarah works at Google.
    await ctx.authorizedIngest("alice", {
      recordId: "a1", orgId: "acme", recordName: "Alice", text: "x",
      entities: [{ name: "Sarah", type: "PERSON" }, { name: "Meta", type: "ORG" }],
      relations: [{ from: "Sarah", to: "Meta", type: "works_at" }],
    })
    await ctx.authorizedIngest("bob", {
      recordId: "b1", orgId: "acme", recordName: "Bob", text: "x",
      entities: [{ name: "Sarah", type: "PERSON" }, { name: "Google", type: "ORG" }],
      relations: [{ from: "Sarah", to: "Google", type: "works_at" }],
    })
    const alice = (await ctx.recallMemories("where does Sarah work", "alice", "acme")).map((m) => m.memory).join(" ")
    const bob = (await ctx.recallMemories("where does Sarah work", "bob", "acme")).map((m) => m.memory).join(" ")
    expect(alice).toContain("Meta") // Alice KEEPS her private memory (was the clash bug)
    expect(alice).not.toContain("Google") // and never sees Bob's
    expect(bob).toContain("Google")
  })

  test("the same user's newer fact still supersedes across their OWN records", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("alice", "acme")
    await ctx.authorizedIngest("alice", {
      recordId: "a1", orgId: "acme", recordName: "A", text: "x",
      entities: [{ name: "Sarah", type: "PERSON" }, { name: "Meta", type: "ORG" }],
      relations: [{ from: "Sarah", to: "Meta", type: "works_at" }],
    })
    await ctx.authorizedIngest("alice", {
      recordId: "a2", orgId: "acme", recordName: "B", text: "x",
      entities: [{ name: "Sarah", type: "PERSON" }, { name: "OpenAI", type: "ORG" }],
      relations: [{ from: "Sarah", to: "OpenAI", type: "works_at" }],
    })
    const alice = (await ctx.recallMemories("where does Sarah work", "alice", "acme")).map((m) => m.memory).join(" ")
    expect(alice).toContain("OpenAI") // scoping didn't break normal within-scope supersession
    expect(alice).not.toContain("Meta")
  })

  test("an org-wide fact updates once for everyone who can see it", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("alice", "acme")
    ctx.ingestor.registerUser("bob", "acme")
    await ctx.authorizedIngest("alice", {
      recordId: "a1", orgId: "acme", recordName: "A", text: "x", shareWithOrg: "acme",
      entities: [{ name: "Acme", type: "ORG" }, { name: "Berlin", type: "PLACE" }],
      relations: [{ from: "Acme", to: "Berlin", type: "headquartered_in" }],
    })
    await ctx.authorizedIngest("bob", {
      recordId: "b1", orgId: "acme", recordName: "B", text: "x", shareWithOrg: "acme",
      entities: [{ name: "Acme", type: "ORG" }, { name: "Munich", type: "PLACE" }],
      relations: [{ from: "Acme", to: "Munich", type: "headquartered_in" }],
    })
    const alice = (await ctx.recallMemories("Acme headquarters", "alice", "acme")).map((m) => m.memory).join(" ")
    const bob = (await ctx.recallMemories("Acme headquarters", "bob", "acme")).map((m) => m.memory).join(" ")
    expect(alice).toContain("Munich") // shared belief updated for all
    expect(bob).toContain("Munich")
    expect(alice).not.toContain("Berlin") // superseded, not duplicated
  })
})
