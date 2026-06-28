// Shared, persistent embedded context for the CLI agent - a single local
// knowledge graph + vector store the `context_ingest` and `get_context` tools both
// use. Single local user (no ACL friction for personal use); zero servers, zero
// config. The DB persists at CONTEXT_DB or the app data dir.

import path from "node:path"
import os from "node:os"
import fs from "node:fs"
import { buildEmbeddedContext, type EmbeddedContext } from "./index"
import { LocalHashEmbeddings } from "./local-embeddings"
import { TransformersEmbeddings, AutoEmbeddings } from "./transformers-embeddings"
import { DeterministicExtractor, HybridExtractor, type KnowledgeExtractor } from "./index"
import { LlmExtractor } from "./llm-extractor"
import { CrossEncoderReranker } from "./reranker"
import type { Reranker } from "./reranker"
import type { Role } from "./authorizer"
import type { EmbeddingProvider } from "../provider"

/** Cross-encoder reranker is ON by default (measured +40% MRR / +27% nDCG, recall
 *  unchanged). It downloads a small (~22M) model on first use and degrades gracefully
 *  to RRF order if unavailable. Disable with CONTEXT_RERANK=0. */
function pickReranker(): Reranker | undefined {
  return /^(0|false|off)$/i.test(process.env.CONTEXT_RERANK ?? "") ? undefined : new CrossEncoderReranker()
}

// Distinct ids - the nodes table is keyed by id, so user and org must not collide.
export const LOCAL_USER = "local-user"
export const LOCAL_ORG = "local-org"

/** WHO is asking. One shared graph (the DB at CONTEXT_DB), but EACH process carries
 *  its own identity from env, so N users hit the same graph and each sees only their
 *  ACL slice. Single-user default (no env) → local-user/local-org/admin, unchanged. */
export interface Identity {
  userId: string
  orgId: string
  role: Role
  groups: string[]
}
export function identity(): Identity {
  const userId = process.env.CONTEXT_USER_ID
  return {
    userId: userId || LOCAL_USER,
    orgId: process.env.CONTEXT_ORG_ID || LOCAL_ORG,
    // explicit identity ⇒ default to least-privilege 'editor'; personal default ⇒ 'admin'.
    role: ((process.env.CONTEXT_USER_ROLE as Role) || (userId ? "editor" : "admin")) as Role,
    groups: (process.env.CONTEXT_USER_GROUPS || "").split(",").map((g) => g.trim()).filter(Boolean),
  }
}

let cached: (EmbeddedContext & { userId: string; orgId: string }) | null = null

export function personalContextPath(): string {
  if (process.env.CONTEXT_DB) return process.env.CONTEXT_DB
  const dir = path.join(os.homedir(), ".local", "share", "100xprompt")
  return path.join(dir, "context.db")
}

/** Pick the embedder from env: real semantic (transformers) or the offline
 *  keyword-hash default. CONTEXT_EMBEDDINGS=transformers enables the real model. */
export function pickEmbeddings(): EmbeddingProvider {
  const mode = (process.env.CONTEXT_EMBEDDINGS ?? "auto").toLowerCase()
  if (mode === "hash") return new LocalHashEmbeddings()
  if (mode === "transformers") return new TransformersEmbeddings(process.env.CONTEXT_EMBED_MODEL || undefined)
  return new AutoEmbeddings(process.env.CONTEXT_EMBED_MODEL || undefined) // default: real, hash fallback
}

/** Build the sovereign/local LLM client if CONTEXT_LLM_URL is set (used for both
 *  typed-triple extraction and KGQA question parsing). */
export function pickLlm(): LlmExtractor | undefined {
  const url = process.env.CONTEXT_LLM_URL
  if (!url) return undefined
  return new LlmExtractor({
    endpoint: url,
    model: process.env.CONTEXT_LLM_MODEL || "default",
    apiKey: process.env.CONTEXT_LLM_KEY,
  })
}

/** Deterministic by default; Hybrid (deterministic + LLM) when a local model is set. */
export function pickExtractor(llm?: LlmExtractor): KnowledgeExtractor {
  return llm ? new HybridExtractor(new DeterministicExtractor(), llm) : new DeterministicExtractor()
}

export function personalContext() {
  if (cached) return cached
  const dbPath = personalContextPath()
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const llm = pickLlm()
  const ctx = buildEmbeddedContext({ path: dbPath, embeddings: pickEmbeddings(), extractor: pickExtractor(llm), llm, reranker: pickReranker() })
  const { userId, orgId, role, groups } = identity()
  // Provision the asking user into the SHARED graph: their role + group memberships
  // drive what they can create and access. Idempotent (INSERT OR REPLACE).
  ctx.ingestor.registerUser(userId, orgId, undefined, role)
  for (const g of groups) {
    ctx.ingestor.registerGroup(g)
    ctx.ingestor.addMembership(userId, g)
  }
  cached = Object.assign(ctx, { userId, orgId })
  return cached
}
