# Chitta: plan to reach the top bracket on LongMemEval

Status: plan, 2026-10-28. Builds on `docs/plans/longmemeval-top-tier.md` (Phases 0-1 done) and the
Phase 2 build (`docs/builds/2026-10-28-chitta-memory-benchmarks-phase2.md`). Every "today" number
below was measured in that work.

## 1. The target, stated so it can be checked

The bracket people mean is **end-to-end answer accuracy on the official `longmemeval_s` set**
(500 questions, each with its own ~50-session, ~115k-token history), graded by **GPT-4o** with
LongMemEval's own scorer (`src/evaluation/evaluate_qa.py`). Published, self-reported claims sit at
85-96% (Mastra Observational Memory 94.87%, Hindsight 91.4%, EmergenceMem 86.0%, Supermemory 85.2%;
Zep 71.2%). They use different readers and judges, so they are a band, not a ranking.

**Target: >= 92% on `longmemeval_s`, official scorer, GPT-4o judge, with the run published
(hypotheses file, config, cost per question) so anyone can reproduce it.** At >= 92% Chitta sits
inside the top cluster; at >= 95% it is at or above every published claim. Secondary targets, so
the work can't overfit one benchmark: LoCoMo answer accuracy reported the same way, and the
zero-LLM retrieval numbers must not drop.

## Update 2026-10-29: Phase A done - first official-set number

Build: `docs/builds/2026-10-28-chitta-top-bracket-reader.md`. On `longmemeval_s` (all 500 questions,
one store per question, no fact keys), Chitta's memory reader with **Gemini 3.1 Pro: 85.8%**
(Gemini 3.8 Flash judge, per-type rules; not GPT-4o, so not leaderboard-comparable). By type:
single-session-assistant 98.2%, abstention 93.3%, knowledge-update 93.1%, single-session-user
92.2%, preference 83.3%, temporal 81.9%, multi-session 75.2%. That clears this plan's Gate B on
three of its four type targets (knowledge-update >= 85, temporal >= 80, multi-session >= 70) and
is level with Supermemory's own Gemini-3-Pro-reader run (85.2%; their GPT-4o headline is 97%) - a gap of 3 questions, within noise.

What's left, in order of payoff: multi-session counting (75.2% - B1/B3 structured facts and
session summaries; these stores have no fact keys), temporal (81.9%), a GPT-4o-judged run (C2,
needs an OpenAI key), and Gate A on the pooled store with the final reader (not run - budget).
Cost: ~$22 measured Gemini for the official runs; see the build for the full spend.

## 2. Where Chitta stood before the reader (2026-10-28)

| Measure (pooled LongMemEval: 940 sessions in one store) | Today |
|---|---|
| Retrieval, zero-LLM: all evidence in top 10 | 73.0% (Phase 1: 70.0%; as shipped before: 59.1%) |
| Retrieval, LLM mode (Gemini fact keys + query rewriting): all evidence in top 10 | 82.3% (recall@10 0.890) |
| **Answer accuracy** (Gemini 3.8 Flash reads + judges, one chunk per session) | **49.4%** (baseline context: 46.2%) |

The LongMemEval paper's best retrieval is recall@10 0.862 on its 500-session setting, so retrieval
is already in the right league. **The gap is reading, not finding**: the evidence is in the
context ~89% of the time, yet only 49% of answers are right.

Answer accuracy by type, and the reason each one is low:

| Type | Today | Why (from the setup used) | The fix (phase) |
|---|---|---|---|
| single-session-user | 78.1% | one chunk per session - often not the chunk with the detail | full rounds per session (A1) |
| single-session-assistant | 62.5% | same, plus the reader is told to answer "just the fact" | full rounds + prompt (A1, A2) |
| knowledge-update | 56.9% | nothing tells the reader which statement is newer | dated, chronologically sorted context; latest-wins rule (A1, A2, B2) |
| temporal-reasoning | 48.0% | dates only on chunk headers; no date arithmetic | event dates on facts, question date, worked arithmetic (A2, B1) |
| multi-session (counting) | 28.1% | 10 sessions, one chunk each - instances are missed and never listed | adaptive breadth + "list every instance, then count" (A3, A2) |
| single-session-preference | 16.7% | the prompt demands a terse fact; preference answers are graded on a rubric for a *personalised* reply | per-type prompt that uses the user's stated tastes (A2) |
| abstention | 70.0% | no calibrated "not in memory" signal | evidence-confidence gate + abstain rule (A4) |

## 3. Phases

Each phase ends at a measurable gate, run the same way every time (section 4). Expected gains are
estimates from the per-type table and the published ablations - the gates decide.

### Phase A - Reading (the largest gain; LLM mode)

- **A1. Reader context = whole evidence, not a fragment.** For the top sessions, give the reader all
  their rounds that matter (best rounds by score, capped), each with its `[date]`, plus that session's
  fact keys; sort chronologically; cap the total (start at 12k tokens, tune 6k-24k). Today the reader
  gets one ~1k-char chunk per session.
- **A2. Per-type reading prompts with Chain-of-Note.** Step 1: extract the relevant notes from each
  session with its date (LongMemEval measured up to 10 points from the reading strategy alone).
  Step 2: answer with a type-specific rule:
  - counting / aggregation: list every distinct instance with its session date, then count;
  - temporal: state each event's date, then compute (days between, before/after) explicitly;
  - knowledge-update: when values conflict, the most recent dated statement wins;
  - preference: answer as a personalised recommendation that uses the user's stated tastes and gear;
  - abstention: say what is missing when no note supports an answer.
- **A3. Question-type router + adaptive breadth.** One cheap LLM call (the same one that rewrites
  the query today) also classifies the question. Counting and multi-session questions get a wider
  retrieval budget (k = 20-30 sessions, all their facts); single-fact questions stay at k = 10.
- **A4. Abstention gate.** Use retrieval confidence (best reranker / fact score) plus the reader's
  note step; answer "not in memory" when no note supports the answer.
- **A5. Reader model tiers.** Gemini 3.8 Flash for development and as the "cost" tier; one strong
  reader (GPT-4o class or Gemini Pro class) for the headline run. Report accuracy and cost per
  question for each.

**Gate A:** pooled-store answer accuracy (Gemini judge) >= 75% with Flash; every type above today.

### Phase B - Memory construction (LLM mode)

- **B1. Structured, dated facts.** Extend fact keys to `{text, subject, attribute, value, event_date}`
  so temporal arithmetic and "latest value" are data, not guesses. Keep the plain-text form as the
  search key.
- **B2. Fact consolidation (knowledge updates).** When a new fact has the same subject + attribute as
  an existing one, mark the older one superseded (Chitta already does this for typed triples in
  `memory/consolidate.ts`; extend it to facts). The reader sees "current" and "previous, until
  <date>".
- **B3. Session summaries / observations.** One dated, prioritised summary per session
  (Mastra-style observations), kept alongside facts and raw rounds. Breadth questions read
  summaries first and pull raw rounds only for the sessions that matter, which keeps the token
  budget flat as histories grow.
- **B4. Cost control.** Cache every extraction by session-content hash (already done for facts in the
  pooled bench); batch sessions per call where the model allows; Flash-Lite for routing/rewrites.

**Gate B:** pooled-store accuracy >= 85% (Gemini judge); knowledge-update >= 85%, temporal >= 80%,
multi-session >= 70%.

### Phase C - The official measurement

- **C1. `longmemeval_s` harness at scale.** Each question has its own history, so build one store
  per question in parallel processes (shard the 500 cases across cores), and cache fact extraction
  by session id - histories share many filler sessions. On a c2d-standard-32 this should take
  about an hour instead of the ~15 hours a single process would need.
- **C2. Official scoring.** Write hypotheses with `--hyps` and score them with LongMemEval's
  `evaluate_qa.py` and GPT-4o (needs an OpenAI key). Keep the Gemini judge as the cheap inner loop
  and check the two agree within ~2 points on a sample.
- **C3. LoCoMo answer accuracy** with the same reader and judge, as the held-out check.

**Gate C:** first official number published, with config and cost. Expect it to land near Gate B.

### Phase D - Close the last points

- **D1. Error review.** Read every wrong answer from the official run and group the causes:
  retrieval miss, wrong session read, arithmetic, judge disagreement. Fix the largest group first.
- **D2. Retrieval for reading.** Raise recall where D1 shows misses: fact-key coverage, the router's
  breadth, cross-encoder over facts.
- **D3. Self-check for counting and temporal questions.** A second reader pass that re-derives the
  count or date difference from the listed notes; on disagreement, answer from the notes.
- **D4. Strong-reader headline run** plus the Flash cost run, both published.

**Gate D (the target):** >= 92% official `longmemeval_s`, GPT-4o judge; LoCoMo reported;
zero-LLM retrieval unchanged or better.

## 4. How every gate is measured

- Pooled store (fast inner loop, ~20 min on the VM): `chitta bench longmemeval --pooled --answer`,
  Gemini reader + judge, per-type table, plus the RRF-context comparison.
- Official (`longmemeval_s`, ~1-2 h): the C1 harness, then `evaluate_qa.py` with GPT-4o.
- Regression guard on every change: pooled retrieval (zero-LLM and LLM), LoCoMo retrieval, and the
  unit suite. A change that lifts one benchmark and drops another doesn't land.

## 5. Cost and time (rough)

| Item | Estimate |
|---|---|
| Fact + summary extraction for `longmemeval_s` (cached; each session once) | ~$20-60 with Gemini Flash |
| Reader + judge per full official run | ~$5 (Flash) to ~$20 (strong reader) + ~$2 GPT-4o judging |
| VM (c2d-standard-32 while running) | ~$1.5/h; delete between runs |
| Engineering | Phase A ~2 days, B ~2-3 days, C ~1 day, D ~2-3 days |

## 6. Guardrails

- No benchmark labels at query or ingest time (question type comes from the router, never the
  dataset); keep the grep check from the Phase 2 build.
- Zero-LLM stays the default and keeps its own numbers; LLM features stay opt-in.
- Every new index (facts, summaries) is a chunk of its record, so it inherits the record's ACL - the
  one thing the top systems don't have and Chitta must keep.
- Report accuracy with tokens and cost per question; a number without its reader, judge and cost
  isn't publishable.
- Hold out LoCoMo (and ideally a small private real-user set) from tuning.

## 7. Order

A1 -> A2 -> A3 -> Gate A -> B1 -> B2 -> Gate B -> C1 -> C2 -> C3 (Gate C) -> D1 -> D2 -> D3 -> D4 (Gate D).
A first official number (C1-C2) can also be taken right after Gate A to calibrate the Gemini judge
early; it costs about one extra run.
