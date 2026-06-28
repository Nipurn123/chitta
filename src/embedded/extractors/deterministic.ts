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
  return { entities: [...entities.values()], relations: [...relations.values()] }
}
