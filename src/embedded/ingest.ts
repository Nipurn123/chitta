// Ingestion - the WRITE side that CREATES the graph + vectors from real input.
// Phase 1 of the lifecycle: parse → chunk → embed → write record node + permission
// edges + chunk vectors. After this runs, retrieval (Phase 2) can resolve the doc.

import type { EmbeddingProvider } from "../provider"
import type { SqliteStore, Json } from "./sqlite-store"
import { DeterministicExtractor, stripBoilerplate, slugify, entityId, type KnowledgeExtractor } from "./extract"
import { CodeExtractor } from "./code-extractor"
import { guardIngest } from "../security/limits"
import { sanitizeBody, sanitizeLabel } from "../security/sanitize"
import { consolidateTriples } from "./memory/consolidate"

// Optional default TTL for dynamic memories (CONTEXT_MEMORY_TTL_DAYS). Unset ⇒ memories
// never auto-expire; set ⇒ non-static memories get a forget_after and the TTL sweep
// retires them. Static facts (names, birthplaces) are always exempt.
function memoryTtlMs(): number | undefined {
  const days = Number(process.env.CONTEXT_MEMORY_TTL_DAYS ?? 0)
  return days > 0 ? days * 24 * 60 * 60 * 1000 : undefined
}

export interface IngestDoc {
  recordId: string
  text: string
  orgId: string
  recordName: string
  virtualRecordId?: string
  mimeType?: string
  connectorId?: string
  origin?: "CONNECTOR" | "UPLOAD"
  /** Principal ids (users/groups) that may see this doc → permission edges. */
  permittedPrincipals?: string[]
  /** If set, the doc is visible to anyone in this org (the "anyone" path). */
  shareWithOrg?: string
  /** Extract a knowledge graph (entities + relations) at ingest. Default true. */
  extractGraph?: boolean
  /** The creator/owner of the record (set by the authorized write path). */
  ownerId?: string
  /** Pre-extracted TYPED graph supplied by the CALLING model (the frontier LLM that
   *  already understood the content). When present, it is stored directly INSTEAD of
   *  running the built-in extractor - so the graph is precise typed triples with NO
   *  separate LLM endpoint needed. */
  entities?: Array<{ name: string; type?: string }>
  relations?: Array<{ from: string; to: string; type: string; confidence?: number }>
}

/** Structure-aware chunker. The old greedy-merge packed many DISTINCT facts into one
 *  chunk → "embedding dilution": a 20-headline chunk has a muddy average vector that
 *  matches no specific query (the Reuters-news failure). Research (2026): recursive
 *  ~512-token chunks are the best general default; FACT-LIST documents (news
 *  headlines, bullet lists) want per-FACT granularity, while flowing prose wants
 *  sentences grouped up to the target. So:
 *   • list-like block (≥4 newline lines, short median) → one chunk PER LINE (no
 *     cross-fact merging) - kills dilution for dense news pages.
 *   • prose block → split into sentences, pack up to `size`.
 *   • a short heading (no terminal punctuation) carries forward and attaches to the
 *     next chunk's content (so "PRICING TIERS:" isn't a useless standalone).
 *  Oversized units are hard-split. No overlap (2026 benchmarks: no measurable gain). */
export function chunkText(text: string, size = 512, minChunk = 80): string[] {
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)
  const out: string[] = []
  let carry = "" // a short heading held to prepend to the following content
  const median = (ns: number[]): number => {
    if (!ns.length) return 0
    const s = [...ns].sort((a, b) => a - b)
    return s[s.length >> 1]
  }
  const flush = (s: string) => {
    let t = (carry ? `${carry} ` : "") + s.trim()
    carry = ""
    while (t.length > size) {
      out.push(t.slice(0, size).trim())
      t = t.slice(size)
    }
    if (t.trim()) out.push(t.trim())
  }
  for (const b of blocks) {
    const lines = b.split("\n").map((l) => l.trim()).filter(Boolean)
    const listLike = lines.length >= 4 && median(lines.map((l) => l.length)) < 120
    if (listLike) {
      for (const l of lines) {
        if (l.length < 30 && !/[.!?]$/.test(l)) carry = (carry ? `${carry} ` : "") + l // tiny fragment → heading
        else flush(l) // each list item / headline becomes its own focused chunk
      }
    } else if (b.length < minChunk && !/[.!?]$/.test(b)) {
      carry = (carry ? `${carry} ` : "") + b // short heading → attach to next block
    } else {
      const sents = b.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean)
      let cur = ""
      for (const s of sents) {
        if (cur && cur.length + s.length + 1 > size) {
          flush(cur)
          cur = s
        } else cur = cur ? `${cur} ${s}` : s
      }
      if (cur) flush(cur)
    }
  }
  if (carry) out.push(carry)
  return out.length ? out : [text.trim()].filter(Boolean)
}

// FUNCTIONAL (single-valued) relations: a subject has at most ONE current value, so
// a newer fact SUPERSEDES the old (user moved cities; company changed CEO). Anything
// not here is multi-valued (partners_with, mentions, knows…) and simply accumulates.
// Only the typed/LLM path emits these predicates; the deterministic path uses
// "relates_to" (symmetric, never functional), so supersession is a no-op there.
const FUNCTIONAL_PREDICATES = new Set([
  "lives_in", "located_in", "based_in", "works_at", "employed_by", "ceo_of", "led_by",
  "born_in", "current_role", "role_is", "status_is", "owns", "owned_by", "married_to",
  "reports_to", "headquartered_in", "capital_of", "member_of",
])

// Entity ids are namespaced (`entity:`) so a slug of free text can never collide with a
// principal (user/org/group) or record id and corrupt the ACL graph via INSERT OR
// REPLACE. The scheme + `entityId()` helper are defined once in extractors/text-hygiene
// (imported above) so every writer here and every resolver (kgqa/entity-link,
// graph/adjacency) agree on it.

export class Ingestor {
  // Code files (detected by extension) are parsed with tree-sitter into a code graph;
  // everything else goes through the configured text/LLM extractor.
  private readonly codeExtractor = new CodeExtractor()
  constructor(
    private readonly store: SqliteStore,
    private readonly embeddings: EmbeddingProvider,
    private readonly extractor: KnowledgeExtractor = new DeterministicExtractor(),
  ) {}

  // --- identity surface (normally fed by an IdP/SCIM sync) ---
  registerOrg(orgId: string, data: Json = {}): void {
    this.store.addNode(orgId, "organizations", data)
  }
  registerUser(userId: string, orgId: string, email?: string, role: "admin" | "editor" | "viewer" = "editor"): void {
    this.store.addNode(userId, "users", { userId, email, role })
    this.store.addNode(orgId, "organizations", {}) // idempotent (INSERT OR REPLACE)
    this.store.addEdge(userId, orgId, "belongsTo")
  }
  registerGroup(groupId: string): void {
    this.store.addNode(groupId, "groups", {})
  }
  addMembership(userId: string, groupId: string): void {
    this.store.addEdge(userId, groupId, "belongsTo")
  }

  // --- the document ingestion pipeline ---
  async ingest(doc: IngestDoc): Promise<{ recordId: string; chunks: number; entities: number }> {
    // SECURITY: enforce size + rate limits on the RAW payload before any work, then strip
    // hidden/bidi/control chars from the text + record name (Trojan-Source / injection
    // hardening). `text` is what gets chunked, embedded, and extracted downstream.
    guardIngest(doc.text)
    const text = sanitizeBody(doc.text)
    const recordName = sanitizeLabel(doc.recordName)
    const vid = doc.virtualRecordId ?? doc.recordId

    // (1) GRAPH: the record node.
    this.store.addNode(doc.recordId, "records", {
      virtualRecordId: vid,
      orgId: doc.orgId,
      recordName,
      mimeType: doc.mimeType ?? "text/plain",
      connectorId: doc.connectorId ?? "upload",
      connectorName: doc.connectorId ?? "upload",
      origin: doc.origin ?? "UPLOAD",
      indexingStatus: "COMPLETED",
      ownerId: doc.ownerId, // creator - used for write/delete authorization
      createdAt: Date.now(), // memory recency baseline (decay/salience re-ranking)
    })

    // (2) GRAPH: permission edges (the ACL) - captured from the source at ingest.
    for (const principal of doc.permittedPrincipals ?? []) {
      this.store.addEdge(principal, doc.recordId, "permissions")
    }
    if (doc.shareWithOrg) {
      this.store.addNode(`anyone:${doc.recordId}`, "anyone", {
        organization: doc.shareWithOrg,
        file_key: doc.recordId,
      })
    }

    // Drop web boilerplate (cookie banners, nav, subscribe CTAs) from PROSE before
    // chunking/extraction so it never becomes a noisy chunk or junk entity. Code is
    // left untouched (a line like "accept" can be real source).
    const isCode = !!CodeExtractor.detectLanguage(doc.recordName)
    const cleanText = isCode ? text : stripBoilerplate(text)

    // (3) VECTORS: chunk → embed → store.
    const chunks = chunkText(cleanText)
    for (let i = 0; i < chunks.length; i++) {
      const embedding = await this.embeddings.embedDense(chunks[i])
      this.store.addChunk(`${doc.recordId}#${i}`, vid, doc.orgId, chunks[i], embedding)
    }

    // (4) KNOWLEDGE GRAPH: extract concepts → entity nodes + relationship edges.
    // record --mentions--> entity, entity --relates_to--> entity. Entity ids are
    // shared across docs, so two records that mention "Pro" link through it.
    let entities = 0
    if (doc.extractGraph !== false) {
      // If the calling (frontier) model supplied a typed graph, store THAT - precise
      // triples, no built-in extractor, no separate LLM. Otherwise fall back to the
      // text/code extractor.
      entities =
        doc.entities?.length || doc.relations?.length
          ? this.writeProvidedGraph(doc.recordId, doc.entities ?? [], doc.relations ?? [])
          : await this.writeGraphFor(doc.recordId, cleanText, doc.recordName)
    }

    // (5) MEMORIES: the living-memory layer. Consolidate the PRECISE typed triples the
    // caller supplied into atomic memories (contradiction → new version, dedup, TTL).
    // We use only the provided typed predicates - the deterministic extractor emits
    // symmetric "relates_to" co-occurrence, which is graph signal, not an atomic fact.
    // Inherits this record's ACL via virtualRecordId. No-op when no typed triples given.
    if (doc.relations?.length) {
      const typed = doc.relations.filter((r) => (r.type || "").trim().toLowerCase().replace(/\s+/g, "_") !== "relates_to")
      if (typed.length) {
        await consolidateTriples(this.store.memories, this.embeddings, typed, {
          orgId: doc.orgId,
          virtualRecordId: vid,
          sourceRecordId: doc.recordId,
          ttlMs: memoryTtlMs(),
        })
      }
    }

    return { recordId: doc.recordId, chunks: chunks.length, entities }
  }

  /** Store a TYPED graph supplied by the calling model (the frontier LLM that read
   *  the content). This is the precise path - no built-in extractor, no separate LLM.
   *  Normalizes relation predicates, stamps confidence + provenance, and applies
   *  bi-temporal supersession for single-valued (functional) relations. Returns the
   *  number of entities written. */
  writeProvidedGraph(
    recordId: string,
    ents: Array<{ name: string; type?: string }>,
    rels: Array<{ from: string; to: string; type: string; confidence?: number }>,
  ): number {
    this.store.clearRecordContributions(recordId)
    const added = new Set<string>()
    const addEntity = (name: string, type?: string) => {
      const slug = slugify(name)
      if (!slug || added.has(slug)) return slug && entityId(slug)
      added.add(slug)
      const id = entityId(slug)
      this.store.addNode(id, "entities", { label: sanitizeLabel(name), type: type ?? "ENTITY" })
      this.store.addEdge(recordId, id, "mentions", { recordId })
      return id
    }
    for (const e of ents) addEntity(e.name, e.type)
    const now = Date.now()
    for (const r of rels) {
      const from = addEntity(r.from) // ensure endpoint nodes exist + are mentioned
      const to = addEntity(r.to)
      if (!from || !to || from === to) continue
      const label = (r.type || "relates_to").trim().toLowerCase().replace(/\s+/g, "_")
      this.store.addEdge(from, to, label, { recordId, validAt: now, confidence: r.confidence })
      if (FUNCTIONAL_PREDICATES.has(label)) this.store.supersedeEdge(from, label, to, now)
    }
    return added.size
  }

  /** Extract concepts from text (or CODE) and attach them to a record (shared by
   *  ingest and rebuildGraph). Code files (detected from `name`) are parsed with
   *  tree-sitter; everything else uses the configured text/LLM extractor. Returns
   *  the number of entities written. */
  async writeGraphFor(recordId: string, text: string, name?: string): Promise<number> {
    // Source-keyed replace (Graphify): if this record was ingested before, drop its
    // prior graph contributions first so facts it no longer asserts are GC'd, weights
    // stay accurate, and re-ingest is idempotent rather than weight-inflating.
    this.store.clearRecordContributions(recordId)

    // Route: code → tree-sitter AST graph; prose → text/LLM extractor.
    const lang = CodeExtractor.detectLanguage(name)
    const extractor = lang ? this.codeExtractor : this.extractor
    const { entities, relations } = await extractor.extract(text, { name, language: lang ?? undefined })
    for (const e of entities) {
      const id = entityId(e.id)
      this.store.addNode(id, "entities", { label: sanitizeLabel(e.label), type: e.type })
      this.store.addEdge(recordId, id, "mentions", { recordId })
    }
    // Store the TYPED predicate as the edge label (calls/defines/imports for code;
    // loves/is_a/… for prose). weight ACCUMULATES across re-mentions (frequency≈
    // confidence); per-edge `confidence` is the EXTRACTED/INFERRED tier; the source
    // record is recorded as provenance so we can trace and supersede a fact later.
    const now = Date.now()
    for (const r of relations) {
      const label = r.type || "relates_to"
      const from = entityId(r.from)
      const to = entityId(r.to)
      this.store.addEdge(from, to, label, { recordId, validAt: now, confidence: r.confidence })
      // Bi-temporal supersession (Graphiti): for a single-valued relation, a newer
      // value closes the prior one - non-destructively (history kept, marked expired).
      if (FUNCTIONAL_PREDICATES.has(label)) this.store.supersedeEdge(from, label, to, now)
    }
    return entities.length
  }
}
