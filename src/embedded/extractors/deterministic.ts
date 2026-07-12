// Deterministic (no-LLM, no-deps) knowledge extractor. Pulls capitalized phrases
// and acronyms as entities and relates entities that co-occur in a sentence-ish
// unit. Runs fully offline. Re-exported from extract.ts to preserve import paths.

import type { Extraction, ExtractedEntity, ExtractedRelation, KnowledgeExtractor } from "./types"

export class DeterministicExtractor implements KnowledgeExtractor {
  async extract(text: string): Promise<Extraction> {
    return extractKnowledge(text)
  }
}

const STOP = new Set([
  "The", "A", "An", "This", "That", "These", "Those", "It", "Our", "Your", "Their", "We", "You",
  "I", "He", "She", "They", "And", "Or", "But", "For", "With", "From", "To", "Of", "In", "On",
  "At", "By", "As", "Is", "Are", "Was", "Were", "Be", "Will", "Each", "All", "Layer", "Step",
  "Both", "Also", "Use", "Used", "Using", "Here", "There", "When", "Then", "Now", "Both",
])

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

// Capitalized phrases (e.g. "100X Prompt Pro", "Fine-Tuned") and acronyms ("SOC-II", "FP8").
const PHRASE = /\b(?:[0-9]+[A-Za-z]+|[A-Z][a-z0-9]+|[A-Z]{2,}(?:-[A-Z0-9]+)?)(?:[ -](?:[A-Z][A-Za-z0-9]+|[A-Z]{2,}(?:-[A-Z0-9]+)?|[0-9]+))*\b/g

function candidates(line: string): ExtractedEntity[] {
  const out: ExtractedEntity[] = []
  const seen = new Set<string>()
  for (const m of line.matchAll(PHRASE)) {
    const label = m[0].trim()
    if (label.length < 2) continue
    if (STOP.has(label)) continue
    // single short common capitalized word at sentence start → skip noise
    if (!label.includes(" ") && !label.includes("-") && label.length < 3) continue
    const id = slug(label)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ id, label, type: /^[A-Z0-9-]+$/.test(label) && label === label.toUpperCase() ? "ACRONYM" : "CONCEPT" })
  }
  return out
}

// High-precision verb/preposition rules → TYPED predicates. Deterministic + zero-token: when
// a capitalized subject and object are linked by one of these, we emit a TYPED relation
// (works_at / lives_in / …) instead of generic co-occurrence. That is what ACTIVATES the
// cognition stack for LLM-free ingestion - KGQA, the living-memory layer, contradiction/
// supersession, and typed graph retrieval all key on typed predicates. Kept HIGH-PRECISION
// (specific verbs + capitalized entities) so noise stays low; unmatched pairs still fall back
// to co-occurrence relates_to. FUNCTIONAL predicates (works_at, lives_in…) are single-valued,
// so a later value SUPERSEDES the old one - the same bi-temporal behavior the LLM path gets.
// A capitalized entity phrase. "." / "&" are allowed INTERNALLY (J.P. Morgan, AT&T); any
// that leak onto the ends are trimmed at capture time so "Meta." → "Meta".
const CAP = "([A-Z][A-Za-z0-9.&]*(?:[ -][A-Z][A-Za-z0-9.&]*)*)"
const REL_RULES: Array<{ verb: string; pred: string }> = [
  { verb: "works? (?:at|for)|worked (?:at|for)|is employed (?:at|by)|now works at|joined", pred: "works_at" },
  { verb: "lives? in|lived in|resides? in|is based in|based in|moved to|relocated to", pred: "lives_in" },
  { verb: "is (?:the )?ceo of|ceo of|leads|is led by|led by|heads|runs|is (?:the )?head of", pred: "led_by" },
  { verb: "founded|co-founded|started", pred: "founded" },
  { verb: "acquired|bought|purchased|has acquired", pred: "acquired" },
  { verb: "partners? with|partnered with|is partnering with", pred: "partners_with" },
  { verb: "is married to|married to|married", pred: "married_to" },
  { verb: "was born in|born in", pred: "born_in" },
  { verb: "reports? to|reporting to", pred: "reports_to" },
  { verb: "manages|is (?:the )?manager of", pred: "manages" },
  { verb: "created|built|developed|designed|invented", pred: "created" },
  { verb: "wrote|authored", pred: "authored" },
  { verb: "invested in|funded|backs|backed", pred: "invested_in" },
  { verb: "is (?:a )?member of|member of|belongs to|is part of|part of", pred: "member_of" },
  { verb: "is headquartered in|headquartered in", pred: "headquartered_in" },
  { verb: "owns|owned by", pred: "owns" },
  { verb: "studied at|graduated from|attended", pred: "studied_at" },
  { verb: "visited|went to|traveled to|flew to", pred: "visited" },
  { verb: "met with|met", pred: "met" },
]
const REL_REGEX = REL_RULES.map((r) => ({ re: new RegExp(CAP + "\\s+(?:" + r.verb + ")\\s+" + CAP, "g"), pred: r.pred }))

// Trim over-captured trailing "." / "&" / space so entity labels are clean.
const trimEnt = (s: string): string => s.trim().replace(/[.&\s]+$/, "").trim()

// Scan the whole text for typed subject-predicate-object patterns; register any endpoint
// that isn't already an entity, and return the typed relations. HARDENED: trims over-capture,
// skips degenerate endpoints, and caps per-doc to keep a pathological input bounded.
function extractTypedRelations(text: string, entities: Map<string, ExtractedEntity>): ExtractedRelation[] {
  const out: ExtractedRelation[] = []
  const seen = new Set<string>()
  const MAX = 200 // bound cost on a pathological doc
  for (const { re, pred } of REL_REGEX) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (out.length >= MAX) return out
      const la = trimEnt(m[1])
      const lb = trimEnt(m[2])
      if (la.length < 2 || lb.length < 2) continue
      const a = slug(la)
      const b = slug(lb)
      if (!a || !b || a === b) continue
      const key = `${a}|${pred}|${b}`
      if (seen.has(key)) continue
      seen.add(key)
      if (!entities.has(a)) entities.set(a, { id: a, label: la, type: "ENTITY" })
      if (!entities.has(b)) entities.set(b, { id: b, label: lb, type: "ENTITY" })
      out.push({ from: a, to: b, type: pred, confidence: 0.6 }) // INFERRED tier (pattern, not LLM)
    }
  }
  return out
}

// ── CONVERSATIONAL extraction (speaker-anchored, zero-token) ──────────────────────────────────
// Casual dialogue ("I went to Japan", "Mel got a puppy") NEVER matches the prose rules above -
// they need a Capitalized SUBJECT + verb + Capitalized OBJECT - so a whole conversation yields
// ZERO typed relations and the graph's cognition sits idle on exactly the data agents see most.
// These rules (a) ANCHOR first-person "I" to the turn's SPEAKER (a leading "Name:" / "Name (date):"
// prefix), and (b) accept a bounded LOWERCASE object, so a dialogue turn produces
// speaker→predicate→object edges. Precision is held by a fixed high-signal verb set, an object
// stop-list, and a per-doc cap - unmatched turns still fall back to entity co-occurrence.
const CONV_RULES: Array<{ verb: string; pred: string }> = [
  { verb: "went to|visited|traveled to|flew to|drove to|have been to|been to", pred: "visited" },
  { verb: "love|loves|like|likes|enjoy|enjoys|prefer|prefers|adore|adores|am into|'m into", pred: "likes" },
  { verb: "hate|hates|dislike|dislikes|can't stand|cannot stand", pred: "dislikes" },
  { verb: "got|bought|adopted|owns?|purchased|have a|have an|has a|has an", pred: "has" },
  { verb: "play|plays|practice|practices", pred: "does" },
  { verb: "works? as|am a|'m a|am an|'m an", pred: "is_a" },
  { verb: "want to|wanna|hope to|plan to|planning to|would love to", pred: "wants_to" },
]
// object: optional determiner (dropped) + 1-3 content words (lowercase or Capitalized).
const OBJ = "(?:the |a |an |my |his |her |their |our |some |new |another )?([A-Za-z][A-Za-z'-]+(?:[ -][A-Za-z][A-Za-z'-]+){0,2})"
const FP = "\\b[Ii]\\b\\s+(?:just |recently |finally |also |really )?"
const CONV_REGEX = CONV_RULES.flatMap((r) => [
  { re: new RegExp(FP + "(?:" + r.verb + ")\\s+" + OBJ, "g"), pred: r.pred, fp: true }, // first-person → speaker
  { re: new RegExp(CAP + "\\s+(?:" + r.verb + ")\\s+" + OBJ, "g"), pred: r.pred, fp: false }, // Name → object
])
// objects too generic to be worth an edge (pronouns, fillers, time words).
const OBJ_STOP = new Set([
  "it", "that", "this", "them", "one", "ones", "some", "lot", "lots", "time", "times", "fun", "things", "thing",
  "stuff", "today", "now", "then", "here", "there", "much", "really", "good", "great", "nice", "sure", "yeah",
  "you", "me", "us", "him", "her", "everyone", "everything", "anything", "something", "someone", "day", "days",
  "way", "ways", "bit", "kind", "sort", "part", "lately", "myself", "yourself",
])
// A captured object over-runs into the next clause ("puppy last week", "japan in march"); cut it
// at the first connective / preposition / time word so only the leading noun phrase remains.
const OBJ_BOUNDARY = new Set([
  "there", "here", "last", "next", "so", "in", "on", "at", "to", "but", "and", "or", "because", "when",
  "this", "that", "my", "his", "her", "their", "our", "yesterday", "today", "tomorrow", "week", "weeks",
  "month", "months", "year", "years", "ago", "recently", "with", "for", "of", "about", "after", "before",
  "since", "while", "really", "just", "also", "too", "then", "now", "who", "which", "where", "the", "a", "an",
  "january", "february", "march", "april", "june", "july", "august", "september", "october", "november",
  "december", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
])
const cleanObj = (s: string): string | null => {
  const words: string[] = []
  for (const w of s.trim().split(/\s+/)) {
    if (OBJ_BOUNDARY.has(w.toLowerCase())) break // stop at a clause boundary
    words.push(w)
  }
  const t = words.join(" ").replace(/['-]+$/, "").trim()
  if (t.length < 3) return null
  const low = t.toLowerCase()
  if (OBJ_STOP.has(low)) return null
  if (low.split(/\s+/).every((w) => OBJ_STOP.has(w))) return null // all-filler phrase
  return t
}

function extractConversationalRelations(text: string, entities: Map<string, ExtractedEntity>): ExtractedRelation[] {
  const out: ExtractedRelation[] = []
  const seen = new Set<string>()
  const MAX = 300
  for (const line of text.split(/\n+/)) {
    // "Name:" or "Name (7 May 2023):" prefix → the turn's speaker (needed to anchor first-person).
    const sm = line.match(/^\s*([A-Z][A-Za-z][A-Za-z .'-]*?)\s*(?:\([^)]*\))?\s*:\s*(.*)$/)
    const speaker = sm ? sm[1].trim() : null
    const body = sm ? sm[2] : line
    for (const { re, pred, fp } of CONV_REGEX) {
      if (fp && !speaker) continue // first-person edge needs a known speaker
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(body)) !== null) {
        if (out.length >= MAX) return out
        const subjLabel = fp ? (speaker as string) : trimEnt(m[1])
        const objRaw = cleanObj(m[fp ? 1 : 2])
        if (!subjLabel || subjLabel.length < 2 || !objRaw) continue
        const a = slug(subjLabel)
        const b = slug(objRaw)
        if (!a || !b || a === b) continue
        const key = `${a}|${pred}|${b}`
        if (seen.has(key)) continue
        seen.add(key)
        if (!entities.has(a)) entities.set(a, { id: a, label: subjLabel, type: fp ? "PERSON" : "ENTITY" })
        if (!entities.has(b)) entities.set(b, { id: b, label: objRaw, type: "CONCEPT" })
        out.push({ from: a, to: b, type: pred, confidence: 0.5 }) // conversational tier (below prose 0.6)
      }
    }
  }
  return out
}

export function extractKnowledge(text: string): Extraction {
  const entities = new Map<string, ExtractedEntity>()
  const relations = new Map<string, ExtractedRelation>()

  // Split into lines / sentence-ish units; entities co-occurring in a unit relate.
  const units = text.split(/[\n.;]+/).map((u) => u.trim()).filter(Boolean)
  for (const unit of units) {
    const ents = candidates(unit)
    for (const e of ents) if (!entities.has(e.id)) entities.set(e.id, e)
    // pairwise co-occurrence within the unit (cap to avoid explosion)
    for (let i = 0; i < ents.length; i++) {
      for (let j = i + 1; j < Math.min(ents.length, i + 6); j++) {
        const [a, b] = [ents[i].id, ents[j].id].sort()
        if (a === b) continue
        relations.set(`${a}|${b}`, { from: a, to: b, type: "relates_to" })
      }
    }
  }
  // TYPED relations (high-precision) on top of co-occurrence - these are what make the
  // graph + memory layer intelligent WITHOUT an LLM.
  for (const r of extractTypedRelations(text, entities)) relations.set(`typed|${r.from}|${r.type}|${r.to}`, r)
  // CONVERSATIONAL relations (speaker-anchored) - so casual dialogue also fills the graph, not
  // just fact-dense prose. Lower-confidence, so a prose typed edge for the same pair still wins.
  for (const r of extractConversationalRelations(text, entities))
    if (!relations.has(`typed|${r.from}|${r.type}|${r.to}`)) relations.set(`conv|${r.from}|${r.type}|${r.to}`, r)

  return { entities: [...entities.values()], relations: [...relations.values()] }
}
