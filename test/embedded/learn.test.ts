// `chitta learn` - walk a repo, remember it permanently. Verifies the walk's judgment
// (code + docs in; junk, binaries, oversized and dep-dirs out), that code really lands as
// a tree-sitter code graph and docs as concepts, that recall works over what was learned,
// and that re-learning is idempotent (stable record ids supersede, never duplicate).

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { buildEmbeddedContext } from "../../src/embedded/index"
import { collectFiles, learnDirectory, renderLearnReport } from "../../src/embedded/learn"

const root = mkdtempSync(join(tmpdir(), "chitta-learn-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

// a miniature repo: real code, real docs, and every kind of junk the walk must refuse
writeFileSync(join(root, "app.py"), "import os\n\nclass Billing:\n    def charge(self):\n        return os.getenv('KEY')\n")
writeFileSync(join(root, "README.md"), "Acme Corp acquired Globex. The billing service charges customers monthly.\n")
mkdirSync(join(root, "node_modules", "dep"), { recursive: true })
writeFileSync(join(root, "node_modules", "dep", "index.js"), "module.exports = 1\n")
mkdirSync(join(root, ".git"))
writeFileSync(join(root, ".git", "config"), "[core]\n")
writeFileSync(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
writeFileSync(join(root, "big.md"), "x".repeat(300_000))
writeFileSync(join(root, "bun.lock"), "{}\n")

const mk = () => {
  const ctx = buildEmbeddedContext({ path: ":memory:" })
  ctx.ingestor.registerUser("u", "o", "e", "admin")
  return ctx
}

describe("chitta learn", () => {
  test("collectFiles keeps code + docs, refuses junk/binary/oversized/dep-dirs", () => {
    const { files, skipped } = collectFiles(root)
    const rels = files.map((f) => f.rel).sort()
    expect(rels).toEqual(["README.md", "app.py"]) // logo.png + bun.lock filtered by name/ext
    expect(files.find((f) => f.rel === "app.py")?.lang).toBe("python")
    expect(files.find((f) => f.rel === "README.md")?.lang).toBe("markdown")
    expect(skipped.dirs).toBeGreaterThanOrEqual(2) // node_modules + .git
    expect(skipped.large).toBeGreaterThanOrEqual(1) // big.md over the byte cap
  })

  test("learn ingests both worlds: a code graph from the .py, concepts from the .md", async () => {
    const ctx = mk()
    const stats = await learnDirectory(ctx, "u", "o", root)
    expect(stats.ingested).toBe(2)
    expect(stats.codeFiles).toBe(1)
    expect(stats.docFiles).toBe(1)
    expect(stats.delta.records).toBe(2)
    expect(stats.delta.entities).toBeGreaterThan(0)

    const acc = await ctx.graph.getAccessibleVirtualRecordIds({ userId: "u", orgId: "o" })
    const g = ctx.graph.getKnowledgeGraph([...new Set(Object.values(acc))] as string[])
    const labels = g.entities.map((e) => e.label)
    expect(labels).toContain("Billing") // tree-sitter class node from app.py
    expect(labels).toContain("app.py") // the FILE node itself
    // the doc landed as recallable memory too
    const res = await ctx.searchWithGraph("who acquired Globex", "u", "o")
    expect(res.searchResults.some((r) => r.content.includes("Acme"))).toBe(true)

    // the report renders and is honest about the shape
    const report = renderLearnReport(stats)
    expect(report).toContain("2 ingested (1 code · 1 docs)")
    expect(report).toContain("python 1")
    ctx.store.close()
  })

  test("re-learning is idempotent: stable record ids supersede, never duplicate", async () => {
    const ctx = mk()
    const first = await learnDirectory(ctx, "u", "o", root)
    expect(first.delta.records).toBe(2)
    const again = await learnDirectory(ctx, "u", "o", root)
    expect(again.delta.records).toBe(0) // same files, same ids - no new records
    ctx.store.close()
  })

  test("maxFiles cap is enforced and reported, not silent", async () => {
    const ctx = mk()
    const stats = await learnDirectory(ctx, "u", "o", root, { maxFiles: 1 })
    expect(stats.ingested).toBe(1)
    expect(stats.skipped.overCap).toBe(1)
    ctx.store.close()
  })
})
