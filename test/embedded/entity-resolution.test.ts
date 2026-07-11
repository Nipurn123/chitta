// Entity resolution / coreference - the canonicalization layer that stops the concept
// graph from fragmenting. Two halves: the pure matching rules (high precision, type-aware)
// and the end-to-end payoff - surface-form variants ("Sarah" / "Sarah Chen") collapse to
// ONE node, so a contradiction asserted under a DIFFERENT surface form still supersedes.

import { describe, expect, test } from "bun:test"
import {
  nameMatch,
  normalizeName,
  editDistance,
  typeBucket,
  compatibleBucket,
  blockingToken,
} from "../../src/embedded/graph/entity-resolution"
import { buildEmbeddedContext } from "../../src/embedded/index"

describe("name matching (pure, high-precision rules)", () => {
  test("normalized equality folds legal suffixes + honorifics + punctuation", () => {
    expect(nameMatch("Acme", "ORG", "Acme, Inc.", "ORG").reason).toBe("equal")
    expect(nameMatch("Dr. Sarah Chen", "PERSON", "Sarah Chen", "PERSON").reason).toBe("equal")
    expect(normalizeName("Acme, Inc.", "org")).toBe("acme")
    expect(normalizeName("Ms. Chen", "person")).toBe("chen")
  })

  test("acronym ↔ expansion", () => {
    expect(nameMatch("IBM", "ORG", "International Business Machines", "ORG").reason).toBe("acronym")
    expect(nameMatch("Museum of Modern Art", "ORG", "MoMA", "ORG").match).toBe(true)
  })

  test("transposition typo (Damerau) matches; distinct short words do not", () => {
    expect(editDistance("anthropic", "anthorpic", 1)).toBe(1)
    expect(nameMatch("Anthropic", undefined, "Anthorpic", undefined).reason).toBe("typo")
    expect(nameMatch("cat", undefined, "car", undefined).match).toBe(false) // too short to risk
  })

  test("person-name containment is coreference; concept containment is NOT (over-merge guard)", () => {
    expect(nameMatch("Sarah", "PERSON", "Sarah Chen", "PERSON").reason).toBe("containment")
    // same strings, but as generic concepts → must NOT merge (products differ by a token)
    expect(nameMatch("Sarah", "CONCEPT", "Sarah Chen", "CONCEPT").match).toBe(false)
    expect(nameMatch("100X Prompt Pro", "CONCEPT", "100X Prompt Flash", "CONCEPT").match).toBe(false)
  })

  test("type gate blocks cross-kind merges even when the strings match", () => {
    expect(compatibleBucket("person", "org")).toBe(false)
    expect(nameMatch("Jordan", "PERSON", "Jordan", "LOCATION").match).toBe(false) // person ≠ place
    expect(typeBucket("Employee")).toBe("person")
    expect(blockingToken("sarah chen")).toBe("sarah")
  })
})

describe("resolution collapses surface forms end to end", () => {
  test("a contradiction under a DIFFERENT surface form still supersedes the old fact", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o")

    // Doc 1 introduces the full name and her employer.
    await ctx.ingestor.ingest({
      recordId: "r1",
      orgId: "o",
      recordName: "Intro",
      text: "Sarah Chen joined the company.",
      permittedPrincipals: ["u"],
      entities: [{ name: "Sarah Chen", type: "PERSON" }, { name: "Meta", type: "ORG" }],
      relations: [{ from: "Sarah Chen", to: "Meta", type: "works_at" }],
    })

    // Doc 2 refers to her by FIRST NAME ONLY and gives a new employer (functional → supersede).
    await ctx.ingestor.ingest({
      recordId: "r2",
      orgId: "o",
      recordName: "Update",
      text: "Sarah now works at OpenAI.",
      permittedPrincipals: ["u"],
      entities: [{ name: "Sarah", type: "PERSON" }, { name: "OpenAI", type: "ORG" }],
      relations: [{ from: "Sarah", to: "OpenAI", type: "works_at" }],
    })

    // The graph has ONE Sarah node (label upgraded to the most specific surface form).
    const acc = await ctx.graph.getAccessibleVirtualRecordIds({ userId: "u", orgId: "o" })
    const g = ctx.graph.getKnowledgeGraph([...new Set(Object.values(acc))])
    const sarahs = g.entities.filter((e) => e.id.includes("sarah"))
    expect(sarahs.length).toBe(1)
    expect(sarahs[0].label).toBe("Sarah Chen")

    // Memory recall returns the CURRENT truth (OpenAI); the superseded Meta fact is gone.
    const mems = await ctx.recallMemories("where does Sarah work", "u", "o")
    const current = mems.map((m) => m.memory).join(" | ")
    expect(current).toContain("OpenAI")
    expect(current).not.toContain("Meta")
  })

  test("distinct products are NOT merged (recall/precision balance holds)", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o")
    await ctx.ingestor.ingest({
      recordId: "p",
      orgId: "o",
      recordName: "Platform",
      text: "100X Prompt Pro is the flagship. 100X Prompt Flash is lightweight.",
      permittedPrincipals: ["u"],
    })
    const acc = await ctx.graph.getAccessibleVirtualRecordIds({ userId: "u", orgId: "o" })
    const labels = ctx.graph.getKnowledgeGraph([...new Set(Object.values(acc))]).entities.map((e) => e.label)
    expect(labels).toContain("100X Prompt Pro")
    expect(labels).toContain("100X Prompt Flash")
  })
})

describe("retroactive dedupe (backfill for pre-resolution data)", () => {
  test("mergeEntities re-points edges + memory subject_keys, deletes the loser", () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    const store = ctx.store
    // Two separate nodes for the same org (as pre-resolver data would have).
    store.addNode("entity:acme", "entities", { label: "Acme", type: "ORG" })
    store.addNode("entity:acme-inc", "entities", { label: "Acme Inc", type: "ORG" })
    store.addEdge("r1", "entity:acme", "mentions", { recordId: "r1" })
    store.addEdge("entity:acme", "entity:x", "partners_with", { recordId: "r1" })
    store.addEdge("entity:acme-inc", "entity:y", "acquired", { recordId: "r2" })
    store.memories.insert({
      id: "m1", orgId: "o", virtualRecordId: "r2", subjectKey: "entity:acme-inc|ceo_of|entity:z",
      memory: "Acme Inc ceo of Z", embedding: [0.1, 0.2],
    })

    const moved = store.mergeEntities("entity:acme-inc", "entity:acme")
    expect(moved).toBeGreaterThan(0)

    // loser gone; its edges now hang off the winner; its memory subject_key rewritten.
    expect(store.db.query("SELECT 1 FROM nodes WHERE id = 'entity:acme-inc'").get()).toBeNull()
    const acquired = store.db.query("SELECT src FROM edges WHERE label = 'acquired'").get() as { src: string }
    expect(acquired.src).toBe("entity:acme")
    const mem = store.db.query("SELECT subject_key FROM memories WHERE id = 'm1'").get() as { subject_key: string }
    expect(mem.subject_key).toBe("entity:acme|ceo_of|entity:z")
  })

  test("dedupeEntities folds obvious duplicates and is idempotent", () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    const store = ctx.store
    store.addNode("entity:international-business-machines", "entities", { label: "International Business Machines", type: "ORG" })
    store.addNode("entity:ibm", "entities", { label: "IBM", type: "ORG" })
    store.addNode("entity:pc", "entities", { label: "PC", type: "PRODUCT" })
    store.addNode("entity:mainframe", "entities", { label: "Mainframe", type: "PRODUCT" })
    store.addEdge("entity:ibm", "entity:pc", "makes", { recordId: "r1" })
    store.addEdge("entity:international-business-machines", "entity:mainframe", "makes", { recordId: "r2" })

    expect(ctx.dedupeEntities()).toBe(1) // IBM ↔ International Business Machines
    expect(ctx.dedupeEntities()).toBe(0) // idempotent
    const ents = store.db.query("SELECT id FROM nodes WHERE coll = 'entities'").all() as Array<{ id: string }>
    expect(ents.length).toBe(3) // one org + PC + Mainframe (the two org nodes became one)
  })
})
