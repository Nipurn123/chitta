// Pseudo-relevance feedback (PRF) - a classic, LLM-FREE recall booster. The evidence for a
// question often doesn't lexically OR semantically match the question ("when did X" vs the
// turn "I went yesterday"), so a single retrieval pass misses it. PRF fixes this
// deterministically: retrieve once, mine the most DISTINCTIVE terms from the top results,
// append them to the query, and retrieve AGAIN - the expanded query now carries vocabulary
// from the relevant region of the corpus, pulling in items the raw query couldn't reach.
// No model, no tokens - just term statistics. (Rocchio/RM3-style, the IR standard since the 90s.)

const STOP = new Set(
  ("the a an and or but for with from into of on in at to by as is are was were be been being this that these those it its" +
    " will would can could should may might must have has had do does did not no yes you your our we they their them he she" +
    " him her his hers ours yours my mine me us so if then than too very just about over under again once here there what" +
    " which who whom whose when where why how all any both each few more most other some such only own same")
    .split(" "),
)

/** The top `n` distinctive terms across `docs` (term frequency), excluding the query's own
 *  terms and stopwords - the feedback vocabulary to expand the query with. */
export function expansionTerms(query: string, docs: string[], n: number): string[] {
  const inQuery = new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
  const tf = new Map<string, number>()
  for (const d of docs) {
    for (const w of d.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []) {
      if (inQuery.has(w) || STOP.has(w)) continue
      tf.set(w, (tf.get(w) ?? 0) + 1)
    }
  }
  return [...tf.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)) // freq desc, then lexical (deterministic)
    .slice(0, n)
    .map(([w]) => w)
}
