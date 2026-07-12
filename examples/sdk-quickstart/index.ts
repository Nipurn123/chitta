// Chitta SDK quickstart — run with:  bun run examples/sdk-quickstart/index.ts
// Permission-aware, zero-token memory in ~40 lines. No servers, no API keys, no LLM tokens.

import { Chitta } from "@100xprompt/chitta"

const memory = new Chitta({ embeddings: "hash", rerank: false }) // hash = offline + deterministic for the demo

// 1) Remember + recall (single user)
await memory.remember("The launch is scheduled for March 3rd.")
await memory.remember("Our primary datastore is PostgreSQL 16.")
console.log("recall →", (await memory.recall("when do we launch?"))[0]?.text)

// 2) Precise typed graph (zero-token) + automatic self-correction
await memory.remember("Sarah Chen works at Google.", {
  entities: [{ name: "Sarah Chen", type: "PERSON" }, { name: "Google", type: "ORG" }],
  relations: [{ from: "Sarah Chen", to: "Google", type: "works_at" }],
})
await memory.remember("Sarah now works at Meta.", {
  entities: [{ name: "Sarah Chen" }, { name: "Meta" }],
  relations: [{ from: "Sarah Chen", to: "Meta", type: "works_at" }],
})
console.log("facts →", (await memory.facts("where does Sarah work")).map((f) => f.memory)) // current truth only
console.log("graph →", (await memory.graph.neighbors("Sarah Chen"))?.neighbors.map((n) => `${n.relation} ${n.label}`))

// 3) Multi-tenant: per-user ACL (the moat) — Bob cannot see Alice's private memory
const alice = memory.user("alice")
const bob = memory.user("bob")
await alice.remember("Alice's private roadmap: ship v2 in Q3.")
console.log("bob sees roadmap? →", (await bob.recall("roadmap")).length, "results") // 0

console.log("about →", memory.about())
memory.close()
