// Normalized benchmark schema - the ONE shape every dataset (LongMemEval, LoCoMo, the
// built-in synthetic suite) maps onto, so the runner is dataset-agnostic. A benchmark is a
// set of CASES; each case is a long HISTORY to ingest into a fresh memory + a set of
// QUESTIONS to answer from it. This is the contract the loaders target and the runner
// consumes - frozen so the loader/QA modules can be built in parallel against it.

/** LongMemEval's five core abilities (+ our extras). The category breakdown is the whole
 *  point: it shows WHICH kind of memory reasoning a system is good/bad at, not one blended
 *  score. Chitta's Stage 3-4 features map onto `temporal` and `knowledge-update` directly. */
export type QuestionCategory =
  | "single-hop" // one fact, one place
  | "multi-hop" // combine facts across sessions
  | "temporal" // order / point-in-time reasoning ("before X", "as of Y")
  | "knowledge-update" // a fact CHANGED across the history → the latest must win (contradiction)
  | "abstention" // the answer is NOT in memory → the correct behavior is "I don't know"
  | "open-domain" // free-form / summary

/** One unit of the history that becomes ONE stored record. Its `id` is the evidence label:
 *  Tier-A retrieval scoring asks "did the memory rank THIS id for the question it supports?" */
export interface HistoryItem {
  id: string
  text: string
  /** Optional dialogue speaker (conversational datasets). */
  speaker?: string
  /** Optional event time (ISO) - drives temporal questions + episodic occurred_at. */
  timestamp?: string
  /** Optional pre-extracted structure a cooperative caller would pass to context_ingest.
   *  Present ⇒ the benchmark exercises the TYPED path (fair vs LLM-extraction systems);
   *  absent ⇒ the deterministic extractor path. */
  entities?: Array<{ name: string; type?: string }>
  relations?: Array<{ from: string; to: string; type: string; confidence?: number }>
}

export interface BenchQuestion {
  id: string
  question: string
  /** Gold answer (Tier-B judge target). */
  answer: string
  category: QuestionCategory
  /** HistoryItem ids that contain the answer - the gold set for Tier-A retrieval recall.
   *  Empty for `abstention` (nothing should support it). */
  evidenceIds: string[]
  /** True when the correct behavior is to NOT answer (answer isn't in the history). */
  abstain?: boolean
}

export interface BenchmarkCase {
  id: string
  history: HistoryItem[]
  questions: BenchQuestion[]
}

export interface BenchmarkDataset {
  name: string
  cases: BenchmarkCase[]
}

/** A dataset source. `path` points at the downloaded dataset file(s); `limit` caps cases
 *  (iterate on a subset, then run the full set once). Synthetic ignores `path`. */
export interface DatasetLoader {
  name: string
  load(opts?: { path?: string; limit?: number }): Promise<BenchmarkDataset>
}
