// Write-side access control: who can create / modify / delete / share.

import { describe, expect, test } from "bun:test"
import { buildEmbeddedContext, type EmbeddedContext } from "../../src/embedded/index"
import { AuthorizationError } from "../../src/embedded/authorizer"

function setup(): EmbeddedContext {
  const ctx = buildEmbeddedContext({ path: ":memory:" })
  ctx.ingestor.registerOrg("acme")
  ctx.ingestor.registerUser("boss", "acme", undefined, "admin")
  ctx.ingestor.registerUser("alice", "acme", undefined, "editor")
  ctx.ingestor.registerUser("vince", "acme", undefined, "viewer")
  ctx.ingestor.registerGroup("finance")
  ctx.ingestor.addMembership("alice", "finance")
  return ctx
}

describe("Authorizer - create authorization", () => {
  test("a viewer CANNOT create records", async () => {
    const ctx = setup()
    await expect(ctx.authorizedIngest("vince", { recordId: "r", orgId: "acme", recordName: "N", text: "hi" })).rejects.toBeInstanceOf(
      AuthorizationError,
    )
  })

  test("an editor CAN create, and becomes the owner (and can read it back)", async () => {
    const ctx = setup()
    const out = await ctx.authorizedIngest("alice", { recordId: "r1", orgId: "acme", recordName: "Note", text: "secret plan" })
    expect(out.recordId).toBe("r1")
    expect(ctx.authorizer.ownerOf("r1")).toBe("alice")
    const acc = await ctx.graph.getAccessibleVirtualRecordIds({ userId: "alice", orgId: "acme" })
    expect(acc["r1"]).toBe("r1") // owner can read
  })
})

describe("Authorizer - grant validation (no over-sharing)", () => {
  test("editor cannot share to a different org", async () => {
    const ctx = setup()
    await expect(
      ctx.authorizedIngest("alice", { recordId: "r", orgId: "acme", recordName: "N", text: "x", shareWithOrg: "rival-corp" }),
    ).rejects.toThrow(/outside your org/)
  })

  test("editor cannot grant to a principal outside their scope", async () => {
    const ctx = setup()
    await expect(
      ctx.authorizedIngest("alice", { recordId: "r", orgId: "acme", recordName: "N", text: "x", permittedPrincipals: ["secret-group"] }),
    ).rejects.toThrow(/outside your scope/)
  })

  test("editor CAN grant to their own group", async () => {
    const ctx = setup()
    const out = await ctx.authorizedIngest("alice", {
      recordId: "r2",
      orgId: "acme",
      recordName: "N",
      text: "x",
      permittedPrincipals: ["finance"], // alice belongs to finance
    })
    expect(out.recordId).toBe("r2")
  })

  test("admin can grant anywhere", async () => {
    const ctx = setup()
    const out = await ctx.authorizedIngest("boss", {
      recordId: "r3",
      orgId: "acme",
      recordName: "N",
      text: "x",
      permittedPrincipals: ["anybody"],
      shareWithOrg: "acme",
    })
    expect(out.recordId).toBe("r3")
  })
})

describe("Authorizer - modify/delete authorization", () => {
  test("a non-owner editor cannot delete someone else's record; owner and admin can", async () => {
    const ctx = setup()
    await ctx.authorizedIngest("alice", { recordId: "doc", orgId: "acme", recordName: "N", text: "x" })
    ctx.ingestor.registerUser("bob", "acme", undefined, "editor")

    expect(() => ctx.deleteRecord("bob", "doc")).toThrow(AuthorizationError) // not owner
    expect(() => ctx.deleteRecord("alice", "doc")).not.toThrow() // owner ok
  })

  test("admin can delete any record", async () => {
    const ctx = setup()
    await ctx.authorizedIngest("alice", { recordId: "doc2", orgId: "acme", recordName: "N", text: "x" })
    expect(() => ctx.deleteRecord("boss", "doc2")).not.toThrow() // admin
    const acc = await ctx.graph.getAccessibleVirtualRecordIds({ userId: "alice", orgId: "acme" })
    expect(acc["doc2"]).toBeUndefined() // gone
  })
})
