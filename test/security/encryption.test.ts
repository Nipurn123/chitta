// Encryption-at-rest (opt-in via CONTEXT_DB_KEY → libSQL transparent whole-file AES).
// The encrypted test is GATED on the optional `libsql` package being installed; the
// default-unencrypted assertion always runs. Embeddings are pinned to hash by the bunfig
// preload, so dims are consistent and nothing downloads.
import { test, expect, describe, afterEach } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"

let libsqlOk = true
try {
  createRequire(import.meta.url)("libsql")
} catch {
  libsqlOk = false
}
const enc = libsqlOk ? test : test.skip

describe("encryption at rest", () => {
  afterEach(() => {
    delete process.env.CONTEXT_DB_KEY
  })

  test("default (no key) is plain bun:sqlite — file is a normal SQLite database", async () => {
    delete process.env.CONTEXT_DB_KEY
    const dir = mkdtempSync(join(tmpdir(), "chitta-plain-"))
    const path = join(dir, "store.db")
    const { buildEmbeddedContext } = await import("../../src/embedded/index")
    const ctx = buildEmbeddedContext({ path })
    ctx.ingestor.registerUser("u", "o", "u@x.com", "editor")
    await ctx.authorizedIngest("u", { recordId: "r", orgId: "o", recordName: "X", text: "hello world", permittedPrincipals: [] })
    ctx.store.close()
    expect(readFileSync(path).subarray(0, 15).toString("latin1")).toBe("SQLite format 3")
    rmSync(dir, { recursive: true, force: true })
  })

  enc("CONTEXT_DB_KEY encrypts the file at rest while preserving retrieval + ACL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chitta-enc-"))
    const path = join(dir, "store.db")
    process.env.CONTEXT_DB_KEY = "test-encryption-key-at-least-32-bytes!"
    const { buildEmbeddedContext } = await import("../../src/embedded/index")
    const ctx = buildEmbeddedContext({ path })
    ctx.ingestor.registerUser("alice", "acme", "a@x.com", "editor")
    ctx.ingestor.registerUser("bob", "acme", "b@x.com", "editor")
    await ctx.authorizedIngest("alice", {
      recordId: "sec", orgId: "acme", recordName: "Secret",
      text: "TOPSECRETMARKER alpha beta gamma delta", permittedPrincipals: [],
    })

    // retrieval still works under encryption (brute-force cosine + FTS)
    const mine = await ctx.retrieval.searchWithFilters({ queries: ["alpha beta gamma"], userId: "alice", orgId: "acme", limit: 5 })
    expect(mine.searchResults.length).toBeGreaterThan(0)
    // ACL still holds under the encrypted driver
    const others = await ctx.retrieval.searchWithFilters({ queries: ["alpha beta gamma"], userId: "bob", orgId: "acme", limit: 5 })
    expect(others.searchResults.map((r) => r.metadata.recordName)).not.toContain("Secret")
    ctx.store.close()

    // the plaintext is NOT recoverable from the raw file, and it's not a plain SQLite db
    const buf = readFileSync(path)
    expect(buf.includes(Buffer.from("TOPSECRETMARKER"))).toBe(false)
    expect(buf.subarray(0, 15).toString("latin1")).not.toBe("SQLite format 3")
    rmSync(dir, { recursive: true, force: true })
  })
})
