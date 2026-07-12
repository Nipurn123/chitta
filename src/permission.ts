// Ported from PipesHub `backend/python/app/models/permission.py`.
// The ACL primitive: a permission is an edge from a principal (user/group/role/
// domain/org/team/anyone) to a record, carrying a role. Mirrors the sharing
// semantics of the source systems (Drive/Slack), so enforcement at query time is
// just a graph traversal over these edges.

export enum PermissionType {
  READ = "READER",
  WRITE = "WRITER",
  OWNER = "OWNER",
  COMMENT = "COMMENTER",
  OTHER = "OTHERS",
}

export enum EntityType {
  USER = "USER",
  GROUP = "GROUP",
  ROLE = "ROLE",
  DOMAIN = "DOMAIN",
  ORG = "ORG",
  TEAM = "TEAM",
  ANYONE = "ANYONE",
  ANYONE_WITH_LINK = "ANYONE_WITH_LINK",
}

export interface Permission {
  externalId?: string
  email?: string
  type: PermissionType
  entityType: EntityType
  createdAt: number
  updatedAt: number
}

/** Generic permission-edge shape consumed by the graph store. */
export interface PermissionEdge {
  from_id: string
  from_collection: string
  to_id: string
  to_collection: string
  role: PermissionType
  type: EntityType
  createdAtTimestamp: number
  updatedAtTimestamp: number
}

export function toGraphPermission(
  perm: Permission,
  fromId: string,
  fromCollection: string,
  toId: string,
  toCollection: string,
): PermissionEdge {
  return {
    from_id: fromId,
    from_collection: fromCollection,
    to_id: toId,
    to_collection: toCollection,
    role: perm.type,
    type: perm.entityType,
    createdAtTimestamp: perm.createdAt,
    updatedAtTimestamp: perm.updatedAt,
  }
}

export interface AccessControl {
  owners: string[]
  editors: string[]
  viewers: string[]
  domains: string[]
  anyoneWithLink: boolean
}
