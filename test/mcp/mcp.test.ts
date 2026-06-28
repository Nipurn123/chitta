// Proves the context system is a real MCP endpoint: we spawn the server as a
// subprocess and talk to it over stdio using the standard MCP client - exactly
// how 100xprompt / Claude Desktop / Cursor would. Ingest, then retrieve.

import { afterAll, describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import path from "node:path"
import fs from "node:fs"

const DB = "/tmp/mcp-context-test.db"
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) try { fs.unlinkSync(f) } catch {}

const serverPath = path.join(import.meta.dir, "../../src/mcp/server.ts")
const transport = new StdioClientTransport({
  command: "bun",
  args: ["run", serverPath],
  env: { ...process.env, CONTEXT_DB: DB },
})
const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} })

afterAll(async () => {
  await client.close()
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) try { fs.unlinkSync(f) } catch {}
})

describe("100x-context MCP endpoint", () => {
  test("connects and lists the context tools", async () => {
    await client.connect(transport)
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(["context_about", "context_forget", "context_graph", "context_ingest", "context_rebuild", "context_relate", "get_context"])
  })

  test("context_about reports capabilities, mode, and tools", async () => {
    const a = await client.callTool({ name: "context_about", arguments: {} })
    const text = (a.content as any)[0].text as string
    expect(text).toContain("mode:")
    expect(text).toContain("vector search:")
    expect(text).toContain("get_context")
  })

  test("context_graph returns the extracted knowledge graph", async () => {
    await client.callTool({
      name: "context_ingest",
      arguments: { name: "Models", content: "100X Prompt Pro and 100X Prompt Flash are Sovereign Models." },
    })
    const g = await client.callTool({ name: "context_graph", arguments: {} })
    expect((g.content as any)[0].text).toContain("concept(s)")
  })

  test("ingest via MCP, then retrieve via MCP", async () => {
    const ing = await client.callTool({
      name: "context_ingest",
      arguments: { name: "Roadmap", content: "Our 2026 roadmap prioritizes the payments platform and fraud detection." },
    })
    expect((ing.content as any)[0].text).toContain("Stored")

    const got = await client.callTool({ name: "get_context", arguments: { query: "what is the roadmap" } })
    expect((got.content as any)[0].text).toContain("Roadmap")
    expect((got.content as any)[0].text).toContain("payments platform")
  })
})
