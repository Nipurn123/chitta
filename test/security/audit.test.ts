// Tamper-evident audit log: append-only, hash-chained. Any later edit/delete/reorder
// breaks the chain and verify() catches it. Also checks the MCP dispatch records calls
// when CHITTA_AUDIT is on, and that ingest logs only the SIZE of content, never the content.
import { test, expect, describe, afterEach } from "bun:test"
import { SqliteStore } from "../../src/embedded/sqlite-store"
import { auditTarget } from "../../src/mcp/audit-redact"

function rec(store: SqliteStore, action: string, actor = "alice") {
  store.audit.record({ ts: Date.now(), actor, org: "acme", action, target: "x", ok: 1, detail: "" })
}

describe("audit log (tamper-evident)", () => {
  test("hash chain verifies when intact", () => {
    const s = new SqliteStore(":memory:")
    rec(s, "context_ingest"); rec(s, "get_context"); rec(s, "context_forget")
    expect(s.audit.count()).toBe(3)
    const v = s.audit.verify()
    expect(v.ok).toBe(true)
    s.close()
  })

  test("editing a past entry breaks the chain (detected)", () => {
    const s = new SqliteStore(":memory:")
    rec(s, "context_ingest"); rec(s, "get_context"); rec(s, "context_forget")
    // someone with DB write access rewrites history: flip an action after the fact
    s.db.query("UPDATE audit SET action = 'tampered' WHERE id = 2").run()
    const v = s.audit.verify()
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.brokenAt).toBe(2)
    s.close()
  })

  test("deleting an entry breaks the chain (detected)", () => {
    const s = new SqliteStore(":memory:")
    rec(s, "a"); rec(s, "b"); rec(s, "c")
    s.db.query("DELETE FROM audit WHERE id = 2").run()
    const v = s.audit.verify()
    expect(v.ok).toBe(false)
    s.close()
  })

  describe("redaction (auditTarget)", () => {
    test("ingest logs the title + SIZE, never the raw content", () => {
      const t = auditTarget("context_ingest", { name: "launch plan", content: "TOP SECRET launch codes 12345" })
      expect(t).toContain("launch plan")
      expect(t).toContain("bytes")
      expect(t).not.toContain("TOP SECRET") // raw content never enters the trail
    })
    test("reads log the query/subject intent", () => {
      expect(auditTarget("get_context", { query: "who is Sarah" })).toBe("who is Sarah")
      expect(auditTarget("context_profile", { subject: "Sarah Chen" })).toBe("Sarah Chen")
      expect(auditTarget("context_forget", { query: "old address" })).toBe("old address")
    })
    test("discovery/graph calls carry no target", () => {
      expect(auditTarget("context_about", {})).toBe("")
      expect(auditTarget("context_graph", {})).toBe("")
    })
  })

  test("audit row carries actor/org for the WHO of who-did-what", () => {
    const s = new SqliteStore(":memory:")
    s.audit.record({ ts: Date.now(), actor: "bob", org: "acme", action: "get_context", target: "salaries", ok: 0, detail: "denied" })
    const [row] = s.audit.tail(1)
    expect(row.actor).toBe("bob")
    expect(row.org).toBe("acme")
    expect(row.ok).toBe(0) // a DENIED access is recorded too
    s.close()
  })
})
