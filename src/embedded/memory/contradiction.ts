// Semantic contradiction detection - beyond functional-predicate supersession. Two facts
// about the SAME subject and object with OPPOSITE-polarity predicates contradict each other
// ("Sarah likes coffee" vs "Sarah dislikes coffee", or the negated "Sarah not_likes coffee").
// Functional supersession can't catch these - they have different predicates, so different
// subject_keys, and would otherwise both live as "current". The newer assertion retires the
// older belief (soft-delete with a reason; history kept).
//
// Deterministic + conservative: an explicit antonym table plus negation normalization - NO
// NLI model - so it only fires on a known opposite, never on merely-different facts.

// Symmetric antonym pairs (both directions are generated below).
const PAIRS: Array<[string, string]> = [
  ["likes", "dislikes"],
  ["loves", "hates"],
  ["supports", "opposes"],
  ["approves", "rejects"],
  ["trusts", "distrusts"],
  ["prefers", "avoids"],
  ["agrees_with", "disagrees_with"],
  ["enables", "blocks"],
  ["allows", "forbids"],
  ["includes", "excludes"],
  ["recommends", "discourages"],
]

const ANTONYMS: Record<string, string[]> = (() => {
  const m: Record<string, Set<string>> = {}
  const add = (a: string, b: string) => ((m[a] ??= new Set()).add(b))
  for (const [a, b] of PAIRS) {
    add(a, b)
    add(b, a)
  }
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [...v]]))
})()

// Negation prefixes an extractor / calling model might emit ("no_longer_works_at").
const NEG = /^(not_|no_longer_|does_not_|doesnt_|didnt_|did_not_|is_not_|isnt_|never_|stopped_|un)/

function stripNeg(pred: string): string {
  return pred.replace(NEG, "")
}

/** The predicates that CONTRADICT `pred` for the same (subject, object): its explicit
 *  antonyms, plus polarity flips via negation ("likes" ↔ "not_likes"/"no_longer_likes";
 *  "no_longer_likes" ↔ "likes"). Returns [] when nothing is known to oppose it. */
export function antonymPredicates(pred: string): string[] {
  const out = new Set<string>()
  const negated = NEG.test(pred)
  const base = negated ? stripNeg(pred) : pred
  for (const a of ANTONYMS[base] ?? []) out.add(a) // antonyms of the base sense
  if (negated) {
    out.add(base) // "no_longer_likes" contradicts "likes"
  } else {
    out.add(`not_${base}`) // "likes" is contradicted by its negations
    out.add(`no_longer_${base}`)
  }
  out.delete(pred)
  return [...out]
}
