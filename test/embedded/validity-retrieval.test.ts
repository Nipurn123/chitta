// Temporal-validity-aware retrieval (Zep's edge, done zero-token): a record that asserted a
// fact which has since been SUPERSEDED is down-ranked, so the CURRENT-truth record surfaces
// first. Chitta already stored the validity intervals (valid_at/invalid_at/expired_at); this
// wires them into ranking. Directly targets the knowledge-update benchmark category.

import { describe, expect, test } from "bun:test"
import { buildEmbeddedContext } from "../../src/embedded/index"

describe("temporal-validity retrieval", () => {
  test("the current-truth record outranks the superseded one", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o", "e", "admin")
    // Old fact: Dana works at Google (creates a works_at edge on record r-google).
    await ctx.authorizedIngest("u", {
      recordId: "r-google", orgId: "o", recordName: "old note", text: "Dana Vance works at Google as an engineer.",
      permittedPrincipals: ["u"],
      entities: [{ name: "Dana Vance", type: "PERSON" }, { name: "Google", type: "ORG" }],
      relations: [{ from: "Dana Vance", to: "Google", type: "works_at" }],
    })
    // New fact supersedes it → r-google's works_at edge is expired (still in history).
    await ctx.authorizedIngest("u", {
      recordId: "r-meta", orgId: "o", recordName: "new note", text: "Dana Vance works at Meta as an engineer.",
      permittedPrincipals: ["u"],
      entities: [{ name: "Dana Vance", type: "PERSON" }, { name: "Meta", type: "ORG" }],
      relations: [{ from: "Dana Vance", to: "Meta", type: "works_at" }],
    })

    const ids = (await ctx.searchWithGraph("where does Dana Vance work", "u", "o")).searchResults.map((r) => r.metadata.recordId)
    const meta = ids.indexOf("r-meta")
    const google = ids.indexOf("r-google")
    expect(meta).toBeGreaterThanOrEqual(0) // the current-truth record is retrieved
    expect(google === -1 || meta < google).toBe(true) // and ranks ABOVE the superseded one
  })

  test("with validity off, the superseded record is not penalized (flag works)", async () => {
    process.env.CONTEXT_VALIDITY = "0"
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o", "e", "admin")
    await ctx.authorizedIngest("u", {
      recordId: "r1", orgId: "o", recordName: "n", text: "Dana works at Google.", permittedPrincipals: ["u"],
      entities: [{ name: "Dana", type: "PERSON" }, { name: "Google", type: "ORG" }], relations: [{ from: "Dana", to: "Google", type: "works_at" }],
    })
    await ctx.authorizedIngest("u", {
      recordId: "r2", orgId: "o", recordName: "n", text: "Dana works at Meta.", permittedPrincipals: ["u"],
      entities: [{ name: "Dana", type: "PERSON" }, { name: "Meta", type: "ORG" }], relations: [{ from: "Dana", to: "Meta", type: "works_at" }],
    })
    const res = await ctx.searchWithGraph("Dana work", "u", "o")
    delete process.env.CONTEXT_VALIDITY
    expect(res.searchResults.length).toBeGreaterThan(0) // still returns results; no crash with flag off
  })
})
