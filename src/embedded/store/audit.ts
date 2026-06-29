// Audit log - an append-only, TAMPER-EVIDENT record of who did what, when. Each entry
// is hash-chained to the previous one (entry.hash = sha256(prev_hash + payload)), so any
// later edit/deletion/reordering breaks the chain and `verify()` catches it - the audit
// trail can't be silently rewritten, even by someone with DB write access. Lives in the
// same store, so it inherits encryption-at-rest when CONTEXT_DB_KEY is set. Opt-in
// (CHITTA_AUDIT) to keep personal use zero-overhead and private by default.

import { createHash } from "node:crypto"
import { Database } from "bun:sqlite"

export interface AuditEntry {
  ts: number
  actor: string // CONTEXT_USER_ID (who)
  org: string
  action: string // tool/operation name (what)
  target: string // redacted summary (query/subject/record name) - never raw content
  ok: number // 1 = success, 0 = error/denied
  detail: string // small JSON blob (e.g. result count) - no sensitive payload
}

export interface AuditRow extends AuditEntry {
  id: number
  prev_hash: string
  hash: string
}

function entryHash(prevHash: string, e: AuditEntry): string {
  return createHash("sha256")
    .update(`${prevHash}\n${e.ts}\n${e.actor}\n${e.org}\n${e.action}\n${e.target}\n${e.ok}\n${e.detail}`)
    .digest("hex")
}

export class AuditRepo {
  constructor(private readonly db: Database) {}

  private lastHash(): string {
    const row = this.db.query("SELECT hash FROM audit ORDER BY id DESC LIMIT 1").get() as { hash: string } | undefined
    return row?.hash ?? "GENESIS"
  }

  /** Append one entry, chained to the previous. Returns the new row's hash. */
  record(e: AuditEntry): string {
    const prev = this.lastHash()
    const hash = entryHash(prev, e)
    this.db
      .query(
        "INSERT INTO audit (ts, actor, org, action, target, ok, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(e.ts, e.actor, e.org, e.action, e.target, e.ok, e.detail, prev, hash)
    return hash
  }

  /** The most recent `n` entries (newest first). */
  tail(n = 50): AuditRow[] {
    return this.db.query("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(n) as AuditRow[]
  }

  count(): number {
    return (this.db.query("SELECT count(*) c FROM audit").get() as { c: number }).c
  }

  /** Re-walk the whole chain and confirm no entry was altered, deleted, or reordered.
   *  Returns the first broken id (and why), or { ok: true } if the chain is intact. */
  verify(): { ok: true; entries: number } | { ok: false; brokenAt: number; reason: string } {
    const rows = this.db.query("SELECT * FROM audit ORDER BY id ASC").all() as AuditRow[]
    let prev = "GENESIS"
    for (const r of rows) {
      if (r.prev_hash !== prev) return { ok: false, brokenAt: r.id, reason: "chain link mismatch (entry inserted/deleted/reordered)" }
      const expect = entryHash(prev, r)
      if (expect !== r.hash) return { ok: false, brokenAt: r.id, reason: "entry contents altered after the fact" }
      prev = r.hash
    }
    return { ok: true, entries: rows.length }
  }
}
