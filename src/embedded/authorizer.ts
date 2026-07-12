// Write-side access control - the mutation counterpart to the read ACL. Answers
// "who can CREATE / MODIFY / DELETE / SHARE what", which read-filtering doesn't.
//
// Roles (per user): admin (full), editor (create + manage own), viewer (read only).
// Ownership: the creator owns a record; only owner or admin may modify/delete it.
// Grant validation: a non-admin can only share within their own org/groups - they
// cannot grant access to principals or orgs outside their scope (no over-sharing).

import type { SqliteStore } from "./sqlite-store"

export type Role = "admin" | "editor" | "viewer"

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AuthorizationError"
  }
}

export class Authorizer {
  constructor(private readonly store: SqliteStore) {}

  roleOf(userId: string): Role {
    const r = this.store.db.query("SELECT data FROM nodes WHERE id = ? AND coll = 'users' LIMIT 1").get(userId) as
      | { data: string }
      | undefined
    if (!r) return "viewer"
    return ((JSON.parse(r.data) as { role?: Role }).role ?? "viewer") as Role
  }

  ownerOf(recordId: string): string | null {
    const r = this.store.db.query("SELECT data FROM nodes WHERE id = ? AND coll = 'records' LIMIT 1").get(recordId) as
      | { data: string }
      | undefined
    return r ? ((JSON.parse(r.data) as { ownerId?: string }).ownerId ?? null) : null
  }

  /** May this user create new records? (editor or admin) */
  canCreate(userId: string): boolean {
    return this.roleOf(userId) !== "viewer"
  }

  /** May this user modify/delete this record? (admin, or the record's owner) */
  canModify(userId: string, recordId: string): boolean {
    return this.roleOf(userId) === "admin" || this.ownerOf(recordId) === userId
  }

  private memberships(userId: string): Set<string> {
    const rows = this.store.db.query("SELECT dst FROM edges WHERE src = ? AND label = 'belongsTo'").all(userId) as Array<{
      dst: string
    }>
    return new Set(rows.map((r) => r.dst))
  }

  private belongsToOrg(principal: string, orgId: string): boolean {
    return !!this.store.db
      .query("SELECT 1 FROM edges WHERE src = ? AND dst = ? AND label = 'belongsTo' LIMIT 1")
      .get(principal, orgId)
  }

  /** A non-admin may only grant to themselves, their own groups/teams, principals
   *  in the same org, or share-with-own-org. Throws on any out-of-scope grant. */
  assertCanGrant(userId: string, orgId: string, principals: string[], shareWithOrg?: string): void {
    if (this.roleOf(userId) === "admin") return
    if (shareWithOrg && shareWithOrg !== orgId) {
      throw new AuthorizationError(`cannot share to org '${shareWithOrg}' - outside your org`)
    }
    const mine = this.memberships(userId)
    for (const p of principals) {
      const ok = p === userId || p === orgId || mine.has(p) || this.belongsToOrg(p, orgId)
      if (!ok) throw new AuthorizationError(`cannot grant access to '${p}' - outside your scope`)
    }
  }

  /** Throws unless the user may create with the requested sharing. */
  assertCanCreate(userId: string, orgId: string, principals: string[], shareWithOrg?: string): void {
    if (!this.canCreate(userId)) {
      throw new AuthorizationError(`user '${userId}' (role: ${this.roleOf(userId)}) is not permitted to create records`)
    }
    this.assertCanGrant(userId, orgId, principals, shareWithOrg)
  }

  assertCanModify(userId: string, recordId: string): void {
    if (!this.canModify(userId, recordId)) {
      const owner = this.ownerOf(recordId) ?? "none"
      throw new AuthorizationError(`user '${userId}' may not modify/delete '${recordId}' (owner: ${owner})`)
    }
  }
}
