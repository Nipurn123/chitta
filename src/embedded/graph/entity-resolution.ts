// Entity resolution / coreference - the canonicalization layer that stops the concept
// graph from fragmenting. Without it, an entity id is just slugify(name), so "Sarah",
// "Sarah Chen" and "Ms. Chen" become THREE separate nodes and every downstream graph
// query, profile, and memory subject_key sees a shattered entity. This module decides,
// for a surface form, the ONE canonical entity id it belongs to.
//
// Design principles (why it looks the way it does):
//   • HIGH PRECISION over recall. Over-merging is corrupting (two real people collapsed
//     into one) and hard to undo; missing a merge just leaves the graph as fragmented as
//     it is today. So every rule here is conservative and explainable.
//   • DETERMINISTIC + dependency-free. String-first (normalized equality, acronym match,
//     edit-distance typos, type-gated name containment) - no LLM, no network, reproducible
//     in tests. Embeddings can only *confirm* a weak string signal, never trigger a merge
//     on their own (kept optional so the offline path stays deterministic).
//   • TYPE-AWARE. A PERSON is never merged into an ORG. Generic types (CONCEPT/ENTITY/
//     ACRONYM/unknown) are compatible with anything, so the deterministic co-occurrence
//     graph (which only emits CONCEPT/ACRONYM) still benefits from the safe rules.
//   • NON-DESTRUCTIVE at the id level. Resolution keeps the FIRST-seen id canonical, so
//     existing edges/memories never need rewriting for forward resolution; new surface
//     forms are recorded as aliases (an O(1) fast path next time) and the human label
//     upgrades to the most specific form. Retroactive merging of two already-separate
//     canonicals is a maintenance op (see store/entities.ts mergeEntities).

import { slugify, entityId } from "../extract"

// Honorifics stripped from PERSON names before comparison, so "Ms. Chen" ≈ "Chen".
const HONORIFICS = new Set(["mr", "mrs", "ms", "miss", "mx", "dr", "prof", "sir", "madam", "madame", "rev", "hon", "capt", "lt", "sgt"])

// Legal-entity suffixes stripped from ORG names, so "Acme" == "Acme Inc" == "Acme, LLC".
// Deliberately ONLY legal suffixes - NOT descriptive words like "labs"/"group"/"holdings"
// (those can distinguish real sibling entities; merging them needs stronger evidence).
const CORP_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co", "company",
  "gmbh", "plc", "ag", "sa", "srl", "bv", "pvt", "lp", "llp", "nv", "oy", "ab", "as",
])

// Non-distinctive tokens: present in a name but too common to key a merge on.
const STOP = new Set(["the", "a", "an", "of", "and", "for", "to", "in", "on", "at", "by", "de", "la", "le", "el", "van", "von"])

// Coarse type buckets. Two names only CONFLICT (block a merge) when BOTH have a known,
// concrete bucket and the buckets differ. Anything unmapped is "generic" ⇒ compatible.
export type TypeBucket = "person" | "org" | "place" | "work" | "generic"

export function typeBucket(type?: string): TypeBucket {
  const t = (type ?? "").trim().toUpperCase()
  if (!t) return "generic"
  if (/(PERSON|PEOPLE|HUMAN|USER|EMPLOYEE|AUTHOR|INDIVIDUAL)/.test(t)) return "person"
  if (/(ORG|COMPANY|CORP|TEAM|INSTITUTION|AGENCY|GROUP|VENDOR|CUSTOMER|BRAND)/.test(t)) return "org"
  if (/(LOC|PLACE|CITY|COUNTRY|STATE|REGION|GPE|ADDRESS|GEO)/.test(t)) return "place"
  if (/(PRODUCT|WORK|MODEL|PROJECT|DOCUMENT|PAPER|BOOK|EVENT)/.test(t)) return "work"
  return "generic"
}

export function compatibleBucket(a: TypeBucket, b: TypeBucket): boolean {
  if (a === "generic" || b === "generic") return true
  return a === b
}

/** Normalize a surface form for comparison: lowercase, strip possessives, drop honorifics
 *  (person) / legal suffixes (org), collapse punctuation to spaces. Bucket-aware because
 *  what's "noise" differs by type (an honorific on an org name is meaningful text). */
export function normalizeName(name: string, bucket: TypeBucket = "generic"): string {
  let s = name.toLowerCase().replace(/['’]s\b/g, "").replace(/[^a-z0-9]+/g, " ").trim()
  let toks = s.split(/\s+/).filter(Boolean)
  if (bucket === "person") toks = toks.filter((t) => !HONORIFICS.has(t))
  if (bucket === "org") while (toks.length > 1 && CORP_SUFFIXES.has(toks[toks.length - 1])) toks.pop()
  s = toks.join(" ")
  return s || name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() // never normalize to empty
}

export function nameTokens(norm: string): string[] {
  return norm.split(/\s+/).filter(Boolean)
}

function distinctive(tok: string): boolean {
  return tok.length >= 4 && !STOP.has(tok) && !CORP_SUFFIXES.has(tok)
}

/** The most distinctive (longest non-stop) token of a normalized name - used as the
 *  BLOCKING key so candidate generation doesn't scan every entity. */
export function blockingToken(norm: string): string | null {
  const toks = nameTokens(norm).filter((t) => !STOP.has(t))
  if (toks.length === 0) return null
  return toks.reduce((a, b) => (b.length > a.length ? b : a))
}

// Initials of a token list, one variant keeping every token and one skipping stopwords,
// so both "MOMA" and "MMA" are offered for "Museum of Modern Art".
function acronyms(toks: string[]): string[] {
  if (toks.length < 2) return []
  const all = toks.map((t) => t[0]).join("")
  const noStop = toks.filter((t) => !STOP.has(t)).map((t) => t[0]).join("")
  return [...new Set([all, noStop])].filter((a) => a.length >= 2)
}

/** Damerau/OSA edit distance (transposition-aware), capped: a swap of two adjacent chars
 *  costs 1, not 2, because that's the single most common real typo ("Anthropic" ↔
 *  "Anthorpic"). Early-exits once a whole row exceeds `max`, so the typo check (max=1) is
 *  cheap. Full matrix (entity names are short). */
export function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0
  const n = a.length
  const m = b.length
  if (Math.abs(n - m) > max) return max + 1
  const d: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = 0; i <= n; i++) d[i][0] = i
  for (let j = 0; j <= m; j++) d[0][j] = j
  for (let i = 1; i <= n; i++) {
    let best = Infinity
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 1)
      d[i][j] = v
      if (v < best) best = v
    }
    if (best > max) return max + 1 // whole row already exceeds the cap → give up early
  }
  return d[n][m]
}

export interface MatchResult {
  match: boolean
  /** 0..1 strength; only used to pick the BEST candidate among several. */
  score: number
  reason: "equal" | "acronym" | "typo" | "containment" | "none"
}

const NO_MATCH: MatchResult = { match: false, score: 0, reason: "none" }

/** Decide whether two surface forms denote the SAME entity. Conservative + explainable.
 *  `threshold` is the minimum score to accept (default 0.85 - all string rules clear it;
 *  a lower value is only meaningful with embedding confirmation, which the caller adds). */
export function nameMatch(
  aName: string,
  aType: string | undefined,
  bName: string,
  bType: string | undefined,
): MatchResult {
  const ba = typeBucket(aType)
  const bb = typeBucket(bType)
  if (!compatibleBucket(ba, bb)) return NO_MATCH // a PERSON is never a company
  // Compare under a shared bucket (a concrete one if either side has it) so honorific/
  // suffix stripping is applied consistently to both names.
  const bucket: TypeBucket = ba !== "generic" ? ba : bb
  const na = normalizeName(aName, bucket)
  const nb = normalizeName(bName, bucket)
  if (!na || !nb) return NO_MATCH

  // 1) Exact after normalization → the same thing ("Acme" vs "Acme, Inc.").
  if (na === nb) return { match: true, score: 1, reason: "equal" }

  const ta = nameTokens(na)
  const tb = nameTokens(nb)

  // 2) Acronym ↔ expansion ("IBM" vs "International Business Machines"). One side is a
  //    single short token that equals the other side's initials.
  const compact = (t: string[]) => t.join("")
  if (ta.length === 1 && acronyms(tb).includes(compact(ta))) return { match: true, score: 0.95, reason: "acronym" }
  if (tb.length === 1 && acronyms(ta).includes(compact(tb))) return { match: true, score: 0.95, reason: "acronym" }

  // 3) Typo / spelling variant on the full normalized string (guarded to longer strings
  //    so short words aren't collapsed - "cat" vs "car" must NOT merge).
  if (Math.min(na.length, nb.length) >= 6 && editDistance(na, nb, 1) <= 1) return { match: true, score: 0.9, reason: "typo" }

  // 4) Name containment ("Sarah" ⊆ "Sarah Chen") - the coreference case. Gated to PERSON
  //    only: for people a first name / last name reliably refers to the same individual,
  //    whereas for concepts/products containment over-merges ("100X Pro" vs "100X Flash").
  if (bucket === "person") {
    const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta]
    const setLong = new Set(long)
    const subset = short.every((t) => setLong.has(t))
    const strongEnough = short.length >= 2 || (short.length === 1 && distinctive(short[0]))
    if (subset && strongEnough && short.length < long.length) return { match: true, score: 0.85, reason: "containment" }
  }

  return NO_MATCH
}

/** A candidate canonical entity to test a surface form against. */
export interface EntityCandidate {
  id: string
  label: string
  type?: string
}

/** Store-side operations the resolver needs. Kept as an interface so the matching logic
 *  stays pure/testable and the SQL lives in store/entities.ts (EntityAliasRepo). */
export interface AliasStore {
  lookup(slug: string): { canonicalId: string } | undefined
  put(slug: string, canonicalId: string, surface: string): void
  candidates(surface: string, bucket: TypeBucket): EntityCandidate[]
  upgradeLabel(canonicalId: string, surface: string): void
}

export interface ResolveOptions {
  /** Optional semantic confirmer: cosine(surface, candidateLabel). Only ever *raises*
   *  confidence on an already-plausible string signal; never creates a match alone. */
  confirm?: (aLabel: string, bLabel: string) => number
  /** Minimum string score to accept without embedding confirmation. Default 0.85. */
  threshold?: number
}

export interface Resolution {
  /** The canonical entity id this surface form resolves to. */
  id: string
  /** The label the entity node should carry (most specific surface seen so far). */
  label: string
  /** True when this surface was folded into an EXISTING canonical (an alias was created). */
  merged: boolean
  /** True when this is the first time we've seen this entity (a brand-new canonical). */
  isNew: boolean
}

/** Resolve a surface form to its canonical entity id, recording aliases as a side effect.
 *  Does NOT create the entity node - it only decides the id + label; the caller (Ingestor)
 *  writes the node. Idempotent per surface form via the alias fast path. */
export function resolveCanonical(store: AliasStore, name: string, type?: string, opts: ResolveOptions = {}): Resolution | null {
  const raw = slugify(name)
  if (!raw) return null
  const bucket = typeBucket(type)
  const norm = normalizeName(name, bucket)
  const normSlug = slugify(norm)
  const threshold = opts.threshold ?? 0.85

  // ── fast path: this exact surface (or its normalized form) is a known alias ──
  const hit = store.lookup(raw) ?? (normSlug !== raw ? store.lookup(normSlug) : undefined)
  if (hit) {
    if (normSlug !== raw) store.put(raw, hit.canonicalId, name) // record the raw form too
    store.upgradeLabel(hit.canonicalId, name)
    return { id: hit.canonicalId, label: name, merged: false, isNew: false }
  }

  // ── candidate merge: is this a variant of an entity we already know? ──
  let best: { c: EntityCandidate; r: MatchResult } | null = null
  for (const c of store.candidates(name, bucket)) {
    let r = nameMatch(name, type, c.label, c.type)
    // Embedding confirmation can rescue a sub-threshold-but-plausible signal (reason set
    // means the strings already look related); it can never invent a match from "none".
    if (!r.match && r.reason !== "none" && opts.confirm && opts.confirm(name, c.label) >= 0.82) {
      r = { ...r, match: true }
    }
    if (r.match && r.score >= threshold && (!best || r.score > best.r.score)) best = { c, r }
  }
  if (best) {
    store.put(raw, best.c.id, name)
    if (normSlug !== raw) store.put(normSlug, best.c.id, name)
    store.upgradeLabel(best.c.id, name)
    return { id: best.c.id, label: name, merged: true, isNew: false }
  }

  // ── brand-new canonical entity ──
  const id = entityId(raw)
  store.put(raw, id, name)
  if (normSlug !== raw) store.put(normSlug, id, name)
  return { id, label: name, merged: false, isNew: true }
}
