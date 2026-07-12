// The Chitta SDK — the ergonomic public API. Verifies the single-user convenience path, the
// zero-token typed-graph path, self-correction, per-user ACL isolation (the permission moat),
// forget, and graph queries. Hash embedder + rerank off ⇒ deterministic, offline, no downloads.

import { describe, expect, test } from "bun:test"
import { Chitta } from "../../src/sdk"

const mk = () => new Chitta({ embeddings: "hash", rerank: false })

describe("Chitta SDK", () => {
  test("remember → recall (single-user)", async () => {
    const m = mk()
    await m.remember("The capital of France is Paris.")
    await m.remember("Bananas are a yellow fruit.")
    const hits = await m.recall("what is the capital of France")
    expect(hits[0]?.text).toContain("Paris")
    m.close()
  })

  test("typed graph + facts (zero-token) and self-correction", async () => {
    const m = mk()
    await m.remember("Sarah Chen works at Google.", {
      entities: [{ name: "Sarah Chen", type: "PERSON" }, { name: "Google", type: "ORG" }],
      relations: [{ from: "Sarah Chen", to: "Google", type: "works_at" }],
    })
    await m.remember("Sarah Chen now works at Meta.", {
      entities: [{ name: "Sarah Chen", type: "PERSON" }, { name: "Meta", type: "ORG" }],
      relations: [{ from: "Sarah Chen", to: "Meta", type: "works_at" }],
    })
    const facts = (await m.facts("where does Sarah Chen work")).map((f) => f.memory).join(" | ")
    expect(facts).toContain("Meta") // current truth
    expect(facts).not.toContain("Google") // superseded, no LLM involved
    const nb = await m.graph.neighbors("Sarah Chen")
    expect(nb?.neighbors.some((n) => n.label === "Meta")).toBe(true)
    m.close()
  })

  test("per-user ACL isolation (the permission moat)", async () => {
    const m = mk()
    const alice = m.user("alice", { role: "member" as never }) // role optional; default editor
    const bob = m.user("bob")
    await alice.remember("Alice's private launch date is March 3.")
    await bob.remember("Bob's private budget is 50k.")
    const bobSees = (await bob.recall("launch date")).map((r) => r.text).join(" ")
    expect(bobSees).not.toContain("March 3") // Bob cannot see Alice's private memory
    const aliceSees = (await alice.recall("launch date")).map((r) => r.text).join(" ")
    expect(aliceSees).toContain("March 3")
    m.close()
  })

  test("forget is non-destructive to current recall", async () => {
    const m = mk()
    // forget operates on the atomic FACT layer, so give it a typed fact to key on.
    await m.remember("Sam prefers Tea.", { entities: [{ name: "Sam" }, { name: "Tea" }], relations: [{ from: "Sam", to: "Tea", type: "prefers" }] })
    expect((await m.facts("Sam prefers")).length).toBeGreaterThan(0)
    const forgot = await m.forget("Sam prefers Tea") // matches the atomic memory text
    expect(forgot.length).toBeGreaterThan(0)
    const facts = (await m.facts("Sam prefers")).map((f) => f.memory).join(" ")
    expect(facts).not.toContain("Tea")
    m.close()
  })

  test("about() reports store stats", async () => {
    const m = mk()
    await m.remember("Acme acquired Globex.", { entities: [{ name: "Acme" }, { name: "Globex" }], relations: [{ from: "Acme", to: "Globex", type: "acquired" }] })
    const info = m.about()
    expect(info.records).toBeGreaterThan(0)
    expect(info.entities).toBeGreaterThan(0)
    expect(typeof info.annEnabled).toBe("boolean")
    m.close()
  })
})
