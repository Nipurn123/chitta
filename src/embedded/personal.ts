// Shared, persistent embedded context for the CLI agent - a single local
// knowledge graph + vector store the `context_ingest` and `get_context` tools both
// use. Single local user (no ACL friction for personal use); zero servers, zero
// config. The DB persists at CONTEXT_DB or the app data dir.

import path from "node:path"
import os from "node:os"
import fs from "node:fs"
import { buildEmbeddedContext, defaultEmbeddings, type EmbeddedContext, type EmbeddedOptions } from "./index"
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

/** Pick the embedder from env - the same resolution as the library default (defaultEmbeddings):
 *  CONTEXT_EMBEDDINGS auto (default: real, hash fallback) | real | transformers | hash | local, and
 *  CONTEXT_EMBED_MODEL / CONTEXT_EMBED_PROFILE for the model. (This used to ignore `real` and the
 *  profile, so the server and `chitta bench` could embed differently.) */
export function pickEmbeddings(): EmbeddingProvider {
  return defaultEmbeddings()
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

/** The retrieval pipeline the MCP server runs (embedder, extractor, LLM, reranker) from env.
 *  `chitta bench` builds from this too, so a benchmark number describes the shipped
 *  configuration - a run that silently dropped the reranker once under-reported Chitta by 6 pts. */
export function serverPipeline(): Pick<EmbeddedOptions, "embeddings" | "extractor" | "llm" | "reranker"> {
  const llm = pickLlm()
  return { embeddings: pickEmbeddings(), extractor: pickExtractor(llm), llm, reranker: pickReranker() }
}

export function personalContext() {
  if (cached) return cached
  const dbPath = personalContextPath()
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const ctx = buildEmbeddedContext({ path: dbPath, ...serverPipeline() })
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
