// context_ingest passes the calling model's fact keys and the content's date through to ingest.
import { test, expect, describe } from "bun:test"
import { contextIngestTool } from "../../src/mcp/tools/context-ingest"
import type { ContextBackend } from "../../src/mcp/backend"
import type { IngestDoc } from "../../src/embedded/ingest"

describe("context_ingest facts + occurred_at", () => {
  test("are advertised in the schema and forwarded to the backend", async () => {
    const props = (contextIngestTool.schema.inputSchema as { properties: Record<string, unknown> }).properties
    expect(Object.keys(props)).toEqual(expect.arrayContaining(["facts", "occurred_at"]))
    let got: IngestDoc | undefined
    const backend = {
      userId: "u",
      orgId: "o",
      ingest: async (doc: IngestDoc) => ((got = doc), { recordId: doc.recordId, chunks: 1, entities: 0 }),
    } as unknown as ContextBackend
    await contextIngestTool.handler(
      { content: "we chatted about dogs", name: "chat", facts: ["The user adopted a beagle named Max.", 42], occurred_at: "2024-03-01" },
      backend,
    )
    expect(got?.facts).toEqual(["The user adopted a beagle named Max."]) // non-strings dropped
    expect(got?.occurredAt).toBe("2024-03-01")
  })
})
