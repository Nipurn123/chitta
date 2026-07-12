// Env-based config loader for the context layer. Dep-free so it stays testable.
// v0 source of truth; later this can be superseded by the CLI config + per-session
// identity (packages/identity) without touching the moat.

import type { ContextConfig } from "./service"

export interface ContextIdentity {
  userId: string
  orgId: string
}

type Env = Record<string, string | undefined>

/** Returns null when the required backend vars aren't set (feature off). */
export function loadContextConfigFromEnv(env: Env): ContextConfig | null {
  const arangoUrl = env.CONTEXT_ARANGO_URL
  const qdrantUrl = env.CONTEXT_QDRANT_URL
  const denseEndpoint = env.CONTEXT_EMBED_URL
  const collectionName = env.CONTEXT_COLLECTION
  if (!arangoUrl || !qdrantUrl || !denseEndpoint || !collectionName) return null

  return {
    arango: {
      url: arangoUrl,
      database: env.CONTEXT_ARANGO_DB ?? "_system",
      username: env.CONTEXT_ARANGO_USER,
      password: env.CONTEXT_ARANGO_PASSWORD,
    },
    qdrant: { url: qdrantUrl, apiKey: env.CONTEXT_QDRANT_API_KEY },
    embeddings: {
      denseEndpoint,
      denseModel: env.CONTEXT_EMBED_MODEL ?? "BAAI/bge-small-en-v1.5",
      sparseEndpoint: env.CONTEXT_SPARSE_URL,
    },
    collectionName,
  }
}

/** The asking user. v0 reads env; production wires this to packages/identity. */
export function loadContextIdentityFromEnv(env: Env): ContextIdentity | null {
  const userId = env.CONTEXT_USER_ID
  const orgId = env.CONTEXT_ORG_ID
  if (!userId || !orgId) return null
  return { userId, orgId }
}

/** Names of the env vars, for help text / diagnostics. */
export const REQUIRED_CONTEXT_ENV = [
  "CONTEXT_ARANGO_URL",
  "CONTEXT_QDRANT_URL",
  "CONTEXT_EMBED_URL",
  "CONTEXT_COLLECTION",
] as const
