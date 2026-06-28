import { describe, expect, test } from "bun:test"
import { loadContextConfigFromEnv, loadContextIdentityFromEnv } from "../src/config-env"

describe("config-env", () => {
  test("returns null when required backend vars are absent (feature off)", () => {
    expect(loadContextConfigFromEnv({})).toBeNull()
    expect(loadContextConfigFromEnv({ CONTEXT_ARANGO_URL: "x" })).toBeNull() // partial
  })

  test("builds full config from env with sensible defaults", () => {
    const cfg = loadContextConfigFromEnv({
      CONTEXT_ARANGO_URL: "http://a:8529",
      CONTEXT_QDRANT_URL: "http://q:6333",
      CONTEXT_EMBED_URL: "http://e:8002",
      CONTEXT_COLLECTION: "records",
    })
    expect(cfg).not.toBeNull()
    expect(cfg!.arango.database).toBe("_system") // default
    expect(cfg!.embeddings.denseModel).toBe("BAAI/bge-small-en-v1.5") // default
    expect(cfg!.collectionName).toBe("records")
  })

  test("identity requires both user and org", () => {
    expect(loadContextIdentityFromEnv({ CONTEXT_USER_ID: "u" })).toBeNull()
    expect(loadContextIdentityFromEnv({ CONTEXT_USER_ID: "u", CONTEXT_ORG_ID: "o" })).toEqual({
      userId: "u",
      orgId: "o",
    })
  })
})
