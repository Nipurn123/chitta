// MCP RESOURCES - read-only, URI-addressable views over the SAME ACL-scoped surfaces
// the tools use, so clients can pull structured JSON without a tool round-trip:
//   memory://graph             the accessible concept map (entities + relations)
//   memory://profile/{entity}  profile synthesis for one entity (permanent/recent/related)
//   memory://stats             store + living-memory counts, plus mode/engine info
// Everything goes through the backend facade (never the store directly), so each payload
// is permission-filtered exactly like the tool responses - a user only ever reads their
// ACL slice. Capability-gated like the tools: a backend without graph/profile/stats
// simply doesn't list (or serve) that resource.

import type { ContextBackend } from "./backend"
import { sanitizeText } from "../security/sanitize"

export interface ResourceEntry {
  uri: string
  name: string
  description: string
  mimeType: string
}

export interface ResourceTemplateEntry {
  uriTemplate: string
  name: string
  description: string
  mimeType: string
}

export interface ResolvedResources {
  /** Fixed resources for resources/list (capability-gated). */
  list: ResourceEntry[]
  /** URI templates for resources/templates/list (capability-gated). */
  templates: ResourceTemplateEntry[]
  /** Resolve one uri → text contents. Throws on unknown/unavailable uris. */
  read: (uri: string) => Promise<{ uri: string; mimeType: string; text: string }>
}

const PROFILE_PREFIX = "memory://profile/"

export function resolveResources(backend: ContextBackend): ResolvedResources {
  const list: ResourceEntry[] = [
    ...(backend.graph
      ? [{
          uri: "memory://graph",
          name: "Knowledge graph",
          description: "The accessible concept map (entities + relations) as JSON, permission-filtered.",
          mimeType: "application/json",
        }]
      : []),
    ...(backend.stats
      ? [{
          uri: "memory://stats",
          name: "Memory stats",
          description: "Store + living-memory counts and engine status as JSON.",
          mimeType: "application/json",
        }]
      : []),
  ]

  const templates: ResourceTemplateEntry[] = backend.profile
    ? [{
        uriTemplate: "memory://profile/{entity}",
        name: "Entity profile",
        description: "Synthesized profile of one entity (permanent facts, recent facts, connections) as JSON, permission-filtered.",
        mimeType: "application/json",
      }]
    : []

  const json = (uri: string, payload: unknown) => ({ uri, mimeType: "application/json", text: JSON.stringify(payload, null, 2) })

  async function read(uri: string): Promise<{ uri: string; mimeType: string; text: string }> {
    if (uri === "memory://graph") {
      if (!backend.graph) throw new Error("memory://graph is not available in this mode")
      return json(uri, await backend.graph())
    }
    if (uri === "memory://stats") {
      if (!backend.stats) throw new Error("memory://stats is not available in this mode")
      const s = await backend.stats()
      return json(uri, {
        mode: backend.mode,
        userId: backend.userId,
        orgId: backend.orgId,
        storage: backend.storage,
        vectorIndex: backend.vectorIndex,
        embeddings: backend.embeddings,
        ...s,
      })
    }
    if (uri.startsWith(PROFILE_PREFIX)) {
      if (!backend.profile) throw new Error("memory://profile is not available in this mode")
      const entity = decodeURIComponent(uri.slice(PROFILE_PREFIX.length)).trim()
      if (!entity) throw new Error("memory://profile/{entity} needs an entity name")
      const p = await backend.profile(entity)
      // Same output hygiene as the profile tool: recalled text is sanitized before it
      // leaves the server. Unknown subject ⇒ an empty (but well-shaped) profile.
      return json(uri, p
        ? {
            subject: sanitizeText(p.subject),
            staticFacts: p.staticFacts.map((f) => sanitizeText(f)),
            recentFacts: p.recentFacts.map((f) => sanitizeText(f)),
            related: p.related.map((r) => sanitizeText(r)),
          }
        : { subject: entity, staticFacts: [], recentFacts: [], related: [] })
    }
    throw new Error(`unknown resource: ${uri}`)
  }

  return { list, templates, read }
}
