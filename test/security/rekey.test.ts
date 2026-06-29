// Key rotation (rekeyDatabase): logical re-encryption copy + atomic swap. The plaintext
// roundtrip always runs (proves the copy/swap mechanics + that the audit hash-chain and
// memories survive verbatim). The encrypt→decrypt roundtrip is gated on the optional
// `libsql` package. Embeddings pinned to hash by the bunfig preload.
import { test, expect, describe, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
import { rekeyDatabase } from "../../src/embedded/store/rekey"
import { buildEmbeddedContext } from "../../src/embedded/index"

let libsqlOk = true
try {
  createRequire(import.meta.url)("libsql")
} catch {
  libsqlOk = false
}
const enc = libsqlOk ? test : test.skip

let dir: string
afterEach(() => {
  delete process.env.CONTEXT_DB_KEY
  if (dir) rmSync(dir, { recursive: true, force: true })
})

async function seed(path: string) {
  const ctx = buildEmbeddedContext({ path })
  ctx.ingestor.registerUser("alice", "acme", "a@acme.com", "admin")
  await ctx.authorizedIngest("alice", {
    recordId: "r1", orgId: "acme", recordName: "job", text: "Sarah works at Meta",
    relations: [{ from: "Sarah", to: "Meta", type: "works_at" }],
  })
  ctx.store.audit.record({ ts: Date.now(), actor: "alice", org: "acme", action: "context_ingest", target: "job", ok: 1, detail: "" })
  ctx.store.close()
}

describe("key rotation", () => {
  test("plaintext copy preserves nodes, memories, and the audit chain; keeps a backup", async () => {
    dir = mkdtempSync(join(tmpdir(), "chitta-rekey-"))
    const path = join(dir, "store.db")
    await seed(path)
    const r = await rekeyDatabase(path, "", "") // plaintext → plaintext (exercises copy/swap)
    expect(r.records).toBeGreaterThan(0)
    expect(r.memories).toBeGreaterThan(0)
    expect(r.chunks).toBeGreaterThan(0)
    expect(existsSync(r.backup)).toBe(true) // original backed up
    // reopen the swapped-in DB: data + tamper-evident audit chain intact
    const ctx = buildEmbeddedContext({ path })
    const mems = await ctx.recallMemories("where does Sarah work", "alice", "acme")
    expect(mems.some((m) => m.memory.includes("Meta"))).toBe(true)
    expect(ctx.store.audit.verify().ok).toBe(true)
    ctx.store.close()
  })

  enc("plaintext → encrypted → decrypt roundtrip keeps data and ciphers the file", async () => {
    dir = mkdtempSync(join(tmpdir(), "chitta-rekey-enc-"))
    const path = join(dir, "store.db")
    await seed(path)
    const KEY = "rotation-key-at-least-32-bytes-long!!"

    // encrypt
    await rekeyDatabase(path, "", KEY)
    expect(readFileSync(path).subarray(0, 15).toString("latin1")).not.toBe("SQLite format 3") // now ciphertext
    process.env.CONTEXT_DB_KEY = KEY
    let ctx = buildEmbeddedContext({ path })
    expect((await ctx.recallMemories("Sarah", "alice", "acme")).length).toBeGreaterThan(0)
    ctx.store.close()

    // decrypt back to plaintext
    await rekeyDatabase(path, KEY, "")
    delete process.env.CONTEXT_DB_KEY
    expect(readFileSync(path).subarray(0, 15).toString("latin1")).toBe("SQLite format 3") // plaintext again
    ctx = buildEmbeddedContext({ path })
    expect((await ctx.recallMemories("Sarah", "alice", "acme")).length).toBeGreaterThan(0)
    ctx.store.close()
  })
})
