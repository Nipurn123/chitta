// DiskANN-in-plaintext (CONTEXT_DISKANN=1): opens the store on libSQL WITHOUT encryption to get
// the native sub-linear vector index in the default (unencrypted) deployment. Verifies the mode
// activates (native index present, ANN enabled) and retrieves correctly - same results as the
// bun:sqlite path, just a different index underneath.

import { afterEach, describe, expect, test } from "bun:test"
import { buildEmbeddedContext } from "../../src/embedded/index"

afterEach(() => {
  delete process.env.CONTEXT_DISKANN
})

describe("DiskANN plaintext ANN (CONTEXT_DISKANN=1)", () => {
  test("activates the native vector index and retrieves the right record", async () => {
    process.env.CONTEXT_DISKANN = "1"
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    expect(ctx.store.annEnabled).toBe(true)
    ctx.ingestor.registerUser("u", "o", "e", "admin")
    await ctx.authorizedIngest("u", { recordId: "r1", orgId: "o", recordName: "n1", text: "the capital of France is Paris", permittedPrincipals: ["u"] })
    await ctx.authorizedIngest("u", { recordId: "r2", orgId: "o", recordName: "n2", text: "bananas are a yellow fruit", permittedPrincipals: ["u"] })
    // native DiskANN index exists (not the sqlite-vec vec0 table)
    expect(ctx.store.db.query("SELECT 1 FROM sqlite_master WHERE name = 'vec_native'").get()).not.toBeNull()
    const res = await ctx.searchWithGraph("what is the capital of France", "u", "o")
    expect((res.searchResults[0]?.metadata as { recordId?: string }).recordId).toBe("r1")
    ctx.store.close()
  })
})
