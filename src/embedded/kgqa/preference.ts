// HIGH-LEVEL (thematic) routing - LightRAG-style dual-level retrieval.
// A query about the USER'S OWN preferences should be answered from the graph's
// preference edges (loves/likes/…), NEVER the vector index - so abstract self-queries
// ("do I like anything logical?") route through the graph, and the frontier LLM then
// filters. A preference NOUN (preferences/interests/hobbies) is self-evidently about
// the user; a preference VERB (like/love) needs a self pronoun so we don't hijack a
// relational query like "does Google love AI".

const PREF_NOUN = /\b(prefer(?:ence)?s?|interests?|hobb(?:y|ies)|favou?rites?|passions?|tastes?)\b/i
const PREF_VERB = /\b(likes?|loves?|loving|enjoys?|enjoying|prefers?|fond|keen|into)\b/i
const SELF_REF = /\b(i|me|my|mine|myself|im|i'm)\b/i

export const PREFERENCE_PREDICATES = new Set([
  "loves", "love", "likes", "like", "enjoys", "enjoy", "prefers", "prefer", "favors", "favours",
  "interested_in", "fond_of", "passionate_about", "fan_of", "keen_on", "into",
])

export function isSelfPreference(q: string): boolean {
  return PREF_NOUN.test(q) || (PREF_VERB.test(q) && SELF_REF.test(q))
}
