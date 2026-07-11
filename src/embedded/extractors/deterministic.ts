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
  { verb: "visited|went to|traveled to|flew to", pred: "visited" },
  { verb: "met with|met", pred: "met" },
]
const REL_REGEX = REL_RULES.map((r) => ({ re: new RegExp(CAP + "\\s+(?:" + r.verb + ")\\s+" + CAP, "g"), pred: r.pred }))

// Scan the whole text for typed subject-predicate-object patterns; register any endpoint
// that isn't already an entity, and return the typed relations.
function extractTypedRelations(text: string, entities: Map<string, ExtractedEntity>): ExtractedRelation[] {
  const out: ExtractedRelation[] = []
  const seen = new Set<string>()
  for (const { re, pred } of REL_REGEX) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const a = slug(m[1])
      const b = slug(m[2])
      if (!a || !b || a === b) continue
      const key = `${a}|${pred}|${b}`
      if (seen.has(key)) continue
      seen.add(key)
      if (!entities.has(a)) entities.set(a, { id: a, label: m[1].trim(), type: "ENTITY" })
      if (!entities.has(b)) entities.set(b, { id: b, label: m[2].trim(), type: "ENTITY" })
      out.push({ from: a, to: b, type: pred, confidence: 0.6 }) // INFERRED tier (pattern, not LLM)
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

  return { entities: [...entities.values()], relations: [...relations.values()] }
}
