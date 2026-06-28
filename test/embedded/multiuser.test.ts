// Multi-user: ONE shared knowledge graph, per-user access control. Every user writes
// into the same graph (shared entity backbone), but each sees only the records + edges
// they're permitted - private, group-shared, or org-wide. This is the ACL moat.
import { test, expect, describe, beforeAll } from "bun:test"
import { buildEmbeddedContext, type EmbeddedContext } from "../../src/embedded/index"
import { AuthorizationError } from "../../src/embedded/authorizer"

const ORG = "acme"
let ctx: EmbeddedContext

// org "acme" with two groups; alice & carol in finance, bob in eng, dave a viewer.
beforeAll(async () => {
  ctx = buildEmbeddedContext({ path: ":memory:" })
  const ing = ctx.ingestor
  ing.registerUser("alice", ORG, "alice@acme.com", "editor")
  ing.registerUser("bob", ORG, "bob@acme.com", "editor")
  ing.registerUser("carol", ORG, "carol@acme.com", "editor")
  ing.registerUser("dave", ORG, "dave@acme.com", "viewer")
  for (const g of ["finance", "eng"]) ing.registerGroup(g)
  ing.addMembership("alice", "finance")
  ing.addMembership("carol", "finance")
  ing.addMembership("bob", "eng")

  // D1 - alice PRIVATE: a secret only she should see
  await ctx.authorizedIngest("alice", {
    recordId: "d1-secret", orgId: ORG, recordName: "Alice secret", text: "secret",
    permittedPrincipals: [], // owner (alice) auto-added; nobody else
    entities: [{ name: "Acme Corporation" }, { name: "Project X" }],
    relations: [{ from: "Acme Corporation", to: "Project X", type: "has_secret" }],
  })
  // D2 - alice → FINANCE group
  await ctx.authorizedIngest("alice", {
    recordId: "d2-finance", orgId: ORG, recordName: "Finance plan", text: "finance",
    permittedPrincipals: ["finance"],
    entities: [{ name: "Acme Corporation" }, { name: "Q3 Budget" }],
    relations: [{ from: "Acme Corporation", to: "Q3 Budget", type: "has_plan" }],
  })
  // D3 - bob → ORG-WIDE
  await ctx.authorizedIngest("bob", {
    recordId: "d3-handbook", orgId: ORG, recordName: "Company handbook", text: "handbook",
    permittedPrincipals: [], shareWithOrg: ORG,
    entities: [{ name: "Acme Corporation" }, { name: "Founded 2020" }],
    relations: [{ from: "Acme Corporation", to: "Founded 2020", type: "founded_in" }],
  })
})

const canSee = async (user: string, recordId: string) => {
  const acc = await ctx.graph.getAccessibleVirtualRecordIds({ userId: user, orgId: ORG })
  return Object.values(acc).includes(recordId)
}
const edgesOf = async (user: string) => {
  const acc = await ctx.graph.getAccessibleVirtualRecordIds({ userId: user, orgId: ORG })
  const kg = ctx.graph.getKnowledgeGraph([...new Set(Object.values(acc))])
  return new Set(kg.relations.map((r) => r.type))
}

describe("record-level access - who can see what", () => {
  test("PRIVATE: only the owner sees alice's secret", async () => {
    expect(await canSee("alice", "d1-secret")).toBe(true)
    for (const u of ["bob", "carol", "dave"]) expect(await canSee(u, "d1-secret")).toBe(false)
  })
  test("GROUP: finance members see the finance plan; others don't", async () => {
    expect(await canSee("alice", "d2-finance")).toBe(true) // owner + finance
    expect(await canSee("carol", "d2-finance")).toBe(true) // finance member
    expect(await canSee("bob", "d2-finance")).toBe(false) // eng, not finance
    expect(await canSee("dave", "d2-finance")).toBe(false) // no group
  })
  test("ORG-WIDE: everyone in acme sees the handbook", async () => {
    for (const u of ["alice", "bob", "carol", "dave"]) expect(await canSee(u, "d3-handbook")).toBe(true)
  })
})

describe("edge-level access - one shared graph, sliced per user", () => {
  test("each user sees exactly the relationships their access permits", async () => {
    // alice: private + finance + org → all three edge types
    expect(await edgesOf("alice")).toEqual(new Set(["has_secret", "has_plan", "founded_in"]))
    // carol: finance + org (no private)
    expect(await edgesOf("carol")).toEqual(new Set(["has_plan", "founded_in"]))
    // bob: org only (eng, not finance, not owner of the secret)
    expect(await edgesOf("bob")).toEqual(new Set(["founded_in"]))
    // dave: org only
    expect(await edgesOf("dave")).toEqual(new Set(["founded_in"]))
  })

  test("UNITY: 'Acme Corporation' is ONE shared entity node, not duplicated per user", () => {
    const node = ctx.store.db.query("SELECT COUNT(*) c FROM nodes WHERE coll='entities' AND id='entity:acme-corporation'").get() as { c: number }
    expect(node.c).toBe(1) // single backbone entity all three records connect through
  })
})

describe("write authorization - who can create / share what", () => {
  test("a viewer cannot create records", async () => {
    await expect(
      ctx.authorizedIngest("dave", { recordId: "x", orgId: ORG, recordName: "x", text: "x", permittedPrincipals: [] }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })
  test("a non-member cannot share to a group they don't belong to (no over-sharing)", async () => {
    await expect(
      ctx.authorizedIngest("bob", { recordId: "y", orgId: ORG, recordName: "y", text: "y", permittedPrincipals: ["finance"] }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })
})

// Regression: extracted entities share the `nodes` table with principals. Their ids
// are slugs of free text, so a document that merely MENTIONS a word matching a
// user/org/group id must NOT overwrite that principal's node (INSERT OR REPLACE) and
// silently strip their access. Entity ids are namespaced (`entity:`) to make the
// collision impossible. See ingest.ts.
describe("ACL integrity - ingested entities cannot clobber principals", () => {
  test("ingesting a doc that names a user does not revoke that user's access", async () => {
    const c = buildEmbeddedContext({ path: ":memory:" })
    const ing = c.ingestor
    ing.registerUser("alice", "org", "alice@x.com", "editor")

    // alice owns a private record
    await c.authorizedIngest("alice", {
      recordId: "alice-doc", orgId: "org", recordName: "Alice doc",
      text: "private", permittedPrincipals: [],
    })
    // a DIFFERENT record whose text mentions "Alice" → extractor mints an entity slug "alice"
    await c.authorizedIngest("alice", {
      recordId: "mention-doc", orgId: "org", recordName: "Mentions Alice",
      text: "Alice leads the platform team and owns the roadmap.", permittedPrincipals: [],
    })

    // The user node must survive as a USER (not be replaced by a CONCEPT entity)…
    const userNode = c.store.db
      .query("SELECT coll FROM nodes WHERE id='alice'")
      .get() as { coll: string } | undefined
    expect(userNode?.coll).toBe("users")

    // …and the entity, if extracted, lives in its own namespace.
    const collided = c.store.db
      .query("SELECT COUNT(*) n FROM nodes WHERE id='alice' AND coll='entities'")
      .get() as { n: number }
    expect(collided.n).toBe(0)

    // The whole point: alice still sees her own record.
    const acc = await c.graph.getAccessibleVirtualRecordIds({ userId: "alice", orgId: "org" })
    expect(Object.values(acc)).toContain("alice-doc")
    c.store.close()
  })
})
