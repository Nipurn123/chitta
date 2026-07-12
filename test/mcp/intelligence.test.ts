// The "intelligent surface" of the MCP server, end-to-end over stdio (real client, real
// subprocess - same as mcp.test.ts): contradiction notes on context_ingest, the
// context_health checkup, and the read-only resources (memory://graph, memory://stats,
// memory://profile/{entity}) - including the two-user ACL leak test: user B must never
// see user A's private entities through a resource.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import path from "node:path"
import fs from "node:fs"

const serverPath = path.join(import.meta.dir, "../../src/mcp/server.ts")

const wipe = (db: string) => {
  for (const f of [db, `${db}-wal`, `${db}-shm`]) try { fs.unlinkSync(f) } catch {}
}

// Spawn one MCP server subprocess on `db` with an optional identity, and connect a client.
async function connect(db: string, env: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", serverPath],
    env: { ...process.env, CONTEXT_DB: db, ...env },
  })
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} })
  await client.connect(transport)
  return client
}

const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as any)[0].text as string

const DB = "/tmp/mcp-intelligence-test.db"
const DB_ACL = "/tmp/mcp-intelligence-acl-test.db"
wipe(DB)
wipe(DB_ACL)

let client: Client

beforeAll(async () => {
  client = await connect(DB)
})

afterAll(async () => {
  await client.close()
  wipe(DB)
  wipe(DB_ACL)
})

describe("contradiction surfacing on context_ingest", () => {
  test("non-superseding ingest carries no note", async () => {
    const r = await client.callTool({
      name: "context_ingest",
      arguments: {
        name: "Sarah joins",
        content: "Sarah Chen works at Google.",
        entities: [{ name: "Sarah Chen", type: "PERSON" }, { name: "Google", type: "ORG" }],
        relations: [{ from: "Sarah Chen", to: "Google", type: "works_at" }],
      },
    })
    expect(text(r)).toContain("Stored")
    expect(text(r)).not.toContain("note:")
  })

  test("superseding ingest says what it replaced", async () => {
    const r = await client.callTool({
      name: "context_ingest",
      arguments: {
        name: "Sarah moves",
        content: "Sarah Chen now works at Meta.",
        entities: [{ name: "Sarah Chen", type: "PERSON" }, { name: "Meta", type: "ORG" }],
        relations: [{ from: "Sarah Chen", to: "Meta", type: "works_at" }],
      },
    })
    const t = text(r)
    expect(t).toContain("Stored")
    expect(t).toContain("note: this superseded a previous belief:")
    expect(t).toContain("Sarah Chen works at Google") // the old belief
    expect(t).toContain("Sarah Chen works at Meta") // the new one
    expect(t).toContain("(now v2; history kept)")
  })

  test("an unrelated fact after the supersession is again note-free", async () => {
    const r = await client.callTool({
      name: "context_ingest",
      arguments: {
        name: "Acme note",
        content: "Acme Corp builds robots.",
        entities: [{ name: "Acme Corp", type: "ORG" }],
        relations: [{ from: "Acme Corp", to: "robots", type: "builds" }],
      },
    })
    expect(text(r)).toContain("Stored")
    expect(text(r)).not.toContain("note:")
  })
})

describe("context_health", () => {
  test("returns store, memory, engine, and hub sections", async () => {
    const r = await client.callTool({ name: "context_health", arguments: {} })
    const t = text(r)
    expect(t).toContain("# Memory health")
    expect(t).toContain("## Store")
    expect(t).toMatch(/\d+ record\(s\), \d+ chunk\(s\), \d+ concept\(s\), \d+ relationship\(s\)/)
    expect(t).toContain("living memory:")
    expect(t).toContain("## Engines")
    expect(t).toContain("vector search:")
    expect(t).toContain("encryption at rest:")
    expect(t).toContain("audit log:")
    expect(t).toContain("## Most-connected concepts")
    expect(t).toContain("Sarah Chen") // the graph's hub after the ingests above
  })
})

describe("MCP resources", () => {
  test("lists memory://graph and memory://stats, plus the profile template", async () => {
    const { resources } = await client.listResources()
    const uris = resources.map((r) => r.uri).sort()
    expect(uris).toEqual(["memory://graph", "memory://stats"])
    const { resourceTemplates } = await client.listResourceTemplates()
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(["memory://profile/{entity}"])
  })

  test("memory://graph is the ACL-scoped concept map as JSON", async () => {
    const { contents } = await client.readResource({ uri: "memory://graph" })
    expect(contents[0].mimeType).toBe("application/json")
    const g = JSON.parse(contents[0].text as string)
    expect(Array.isArray(g.entities)).toBe(true)
    expect(Array.isArray(g.relations)).toBe(true)
    expect(g.entities.map((e: any) => e.label)).toContain("Sarah Chen")
  })

  test("memory://stats is valid JSON with live counts", async () => {
    const { contents } = await client.readResource({ uri: "memory://stats" })
    const s = JSON.parse(contents[0].text as string)
    expect(s.mode).toBe("local")
    expect(s.records).toBeGreaterThanOrEqual(3)
    expect(s.memories.current).toBeGreaterThanOrEqual(1)
  })

  test("memory://profile/{entity} synthesizes the current (revised) profile", async () => {
    const { contents } = await client.readResource({ uri: `memory://profile/${encodeURIComponent("Sarah Chen")}` })
    const p = JSON.parse(contents[0].text as string)
    expect(p.subject).toBe("Sarah Chen")
    const facts = [...p.staticFacts, ...p.recentFacts].join(" | ")
    expect(facts).toContain("Meta") // the superseding truth, not the superseded one
  })

  test("unknown resource uri errors", async () => {
    await expect(client.readResource({ uri: "memory://nope" })).rejects.toThrow()
  })
})

describe("resources respect the ACL (two users, one shared DB)", () => {
  test("user B cannot see user A's private entities in memory://graph", async () => {
    // Sequential sessions against the SAME SQLite file (the documented multi-user
    // embedded mode): alice writes a PRIVATE record, then bob opens the store.
    const alice = await connect(DB_ACL, { CONTEXT_USER_ID: "alice", CONTEXT_ORG_ID: "acme" })
    const ing = await alice.callTool({
      name: "context_ingest",
      arguments: {
        name: "Vulcan plan",
        content: "Project Vulcan is led by Alice.",
        entities: [{ name: "Project Vulcan", type: "PROJECT" }, { name: "Alice", type: "PERSON" }],
        relations: [{ from: "Project Vulcan", to: "Alice", type: "led_by" }],
      },
    })
    expect(text(ing)).toContain("Stored")

    // Sanity: the owner DOES see it through the resource.
    const aliceGraph = JSON.parse((await alice.readResource({ uri: "memory://graph" })).contents[0].text as string)
    expect(aliceGraph.entities.map((e: any) => e.label)).toContain("Project Vulcan")
    await alice.close()

    const bob = await connect(DB_ACL, { CONTEXT_USER_ID: "bob", CONTEXT_ORG_ID: "acme" })
    const bobGraph = JSON.parse((await bob.readResource({ uri: "memory://graph" })).contents[0].text as string)
    expect(JSON.stringify(bobGraph)).not.toContain("Vulcan") // no entity, no relation, no leak

    // The profile resource is scoped the same way: bob gets an EMPTY profile, not alice's.
    const bobProfile = JSON.parse(
      (await bob.readResource({ uri: `memory://profile/${encodeURIComponent("Project Vulcan")}` })).contents[0].text as string,
    )
    expect(bobProfile.staticFacts).toEqual([])
    expect(bobProfile.recentFacts).toEqual([])
    expect(bobProfile.related).toEqual([])
    await bob.close()
  })
})
