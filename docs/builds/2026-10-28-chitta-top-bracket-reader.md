# Chitta Top Bracket Reader Buildout

Created: 2026-10-28
Agent: Claude Code
Status: PENDING
Approved: Yes
Rounds: 1
Worktree: No
Type: Build

## Summary

**Goal:** Turn what Chitta retrieves into correct answers - close the reading gap measured in the Phase 2 build (evidence found ~89% of the time, answers right 51%) so Chitta's end-to-end accuracy on the official `longmemeval_s` set beats Supermemory's self-reported 85.2% and Zep's 71.2%, following Phase A of `docs/plans/chitta-top-bracket.md` (plus whatever B/C/D work the failures call for).

**Oracle:** On the official `longmemeval_s` set (500 questions, one store per question), Chitta's memory reader with Gemini 3.1 Pro answers more than 85.2% correctly, graded by Gemini 3.8 Flash with LongMemEval's per-type rules, all 500 questions answered and the hypotheses file written. (Gemini-judged, so labelled "not leaderboard-comparable" - the user chose the Gemini judge over GPT-4o.)

**Misfire:** Accuracy rises through things that don't make Chitta better: reading dataset labels (question_type, gold sessions) at answer time, a reader that answers from outside knowledge instead of memory, prompts keyed to LongMemEval's phrasing, or a zero-LLM product that regresses while the LLM path improves. Caught by Criteria 4 and 6, and by keeping the judge's rules exactly as built in the Phase 2 build.

**Constraints:** Current branch (`main` working tree, on top of the uncommitted Phase 0-2 work). Zero-LLM retrieval stays the default and keeps its numbers; the reader is LLM mode only. Every new index stays a chunk of its record (ACL inherited). Judge rules and benchmark scoring code are not changed in this build. Spend ceiling $100 (Gemini on Vertex, project <gcp-project>, measured by `tools/lme-pooled/vertex-proxy.ts`) plus the VM.

**Assumed:** Gemini 3.1 Pro (`google/gemini-3.1-pro-preview`) is the strongest Pro model this project serves (3.5/3.8 Pro return 404). Gemini 3.8 Flash list price ~$0.75 / $3.75 per 1M tokens (third-party sources; introductory until 2026-12-31). The `build-review` / `changes-review` agents are not available here, so neither reviewer runs (disclosed in Not Verified).

## Acceptance Criteria

- [x] Criterion 1 (oracle): The `longmemeval_s` answer run (Chitta memory reader, Gemini 3.1 Pro, Gemini 3.8 Flash judge with the per-type rules) reports overall accuracy > 85.2% over all 500 questions, with the hypotheses file written (log line quoted in the Round Log).
- [ ] Criterion 2: On the pooled 940-session store, Chitta's memory reader with Gemini 3.8 Flash scores >= 75.0%, and higher than the same reader given the BM25+dense RRF baseline's records.
- [x] Criterion 3: In the `longmemeval_s` run of Criterion 1, every question type (the six LongMemEval types plus abstention) scores >= 70.0%.
- [x] Criterion 4: Zero-LLM retrieval does not regress: `bench longmemeval --pooled` (reranker on, no LLM) reports all-gold@10 >= 0.730 with GATE PASS, and `bench locomo --tier a --k 10` reports recall@10 >= 0.624 and MRR >= 0.439.
- [x] Criterion 5: Measured Gemini spend for this build (sum of the proxy's per-model token totals at list price) is <= $100.
- [x] Criterion 6: No code under `src/embedded/` reads dataset labels (`question_type`, `answer_session_ids`, `_abs`, `has_answer`) - grep shows none - every new reader behaviour has a unit test on non-benchmark text, `bun test test/` passes with 0 failures, and `tsc --noEmit` shows no errors outside the pre-existing `src/http/kb-mcp.ts`.

## Progress Tracking

- [x] Task 1: Build the memory reader
- [x] Task 2: Question router and adaptive breadth
- [ ] Task 3: Pooled-store answer benchmark on the reader (Gate A) - BLOCKED (budget)
- [x] Task 4: longmemeval_s harness with parallel per-question stores
- [x] Task 5: Official-set runs and fixes from the failures
- [x] Task 6: Docs, plan and changelog

## Implementation Tasks

### Task 1: Build the memory reader

**Objective:** An LLM-mode reader in Chitta (`answerQuestion`) that assembles the evidence for the top sessions - their best rounds in full plus their fact keys, each dated, sorted chronologically, under a token cap - and answers with a Chain-of-Note prompt (notes per session with dates, then the answer) carrying per-kind rules: list-then-count, dates-then-arithmetic, newest-statement-wins, personalised recommendations, and "not in memory" when no note supports an answer.

### Task 2: Question router and adaptive breadth

**Objective:** Fold question classification into the existing rewrite call (one LLM call: kind + search queries), and give counting / multi-session questions a wider retrieval budget than single-fact ones, so aggregation questions see all their instances.

### Task 3: Pooled-store answer benchmark on the reader (Gate A)

**Objective:** Point `bench longmemeval --pooled --answer` at the memory reader for Chitta and for the RRF baseline's records (same reader, same assembly), measure with Gemini 3.8 Flash, and iterate on the per-type failures until Gate A holds.

### Task 4: longmemeval_s harness with parallel per-question stores

**Objective:** Run `longmemeval_s` end to end - one store per question, built in parallel worker processes, then the reader - writing per-type accuracy and the hypotheses file, fast enough to run inside this session.

### Task 5: Official-set runs and fixes from the failures

**Objective:** Run the official set with Flash to calibrate, review the wrong answers by cause, fix the largest causes, then run the headline with Gemini 3.1 Pro.

### Task 6: Docs, plan and changelog

**Objective:** Record the reader, its options and the numbers in docs/plans/chitta-top-bracket.md, CHANGELOG.md, docs/BENCHMARKING.md and docs/API.md.

## Round Log

- Round 1, Tasks 1-2: `src/embedded/reader.ts` - route (kind + rewrites in one call, `LlmExtractor.routeQuestion`), search (k 10, 20 for aggregate/temporal), gather (per session: fact keys + best 3 rounds by query similarity, dated, sessions in date order, 48k-char budget), read (Chain-of-Note with rules for counting, dates, changed facts, recommendations, "not in memory"). `ctx.answerQuestion(...)`; `hybridSearch` takes precomputed `expansions`. Bench: `bench longmemeval --pooled --answer --reader [--reader-model m]` - same reader over Chitta's vs RRF's sessions. 5 reader tests; suite 444 pass. Proxy restarted with token accounting (Gemini 3.8 Flash list price) - spend before this build is not counted in Criterion 5.
- Round 1, Task 3: Gate A run (llm2 store, Flash reader + judge). At 8 questions in flight it would take ~2.5 h (Vertex 15-20 s/call); restarted at 32 (`--concurrency`), which hit the shared Vertex quota (1,117 retries / 2,098 calls by 350/500) - some answers may be empty from exhausted retries; counting them when it finishes.
- Round 1, Task 4: `src/eval/bench/per-question.ts` + `bench longmemeval --per-question --shard i/N --out f [--store-dir d] [--ingest-only]` and `--merge`. Profile: ingest is ~all embedding (1.04 s/session real vs 0.03 s hash, M3 Pro), so `longmemeval_s` (23,867 session ingests) runs on a separate c2d-standard-56 VM (`chitta-bench-s`). 28 shards with one ONNX thread pool each ran at load ~600: added `CONTEXT_EMBED_THREADS` (embedder + reranker; default unchanged), 2 per shard -> load ~41, ~28 stores / 3 min. Stores are saved per question and reused (`.ok` marker after a complete ingest). Ingest is now separate from reading (`--ingest-only`) so reading runs later under a controlled rate. Proxy: up to 10 attempts with jittered backoff capped at 60 s, and a FAILED count.
- Round 1, Gate A first run (rA, concurrency 32, old proxy): Chitta-reader 64.6% vs RRF-reader 63.8% (was 51.2% with the plain one-chunk context); preference 76.7% (was 10.0), knowledge-update 87.5% (was 55.6), ss-assistant 91.1%, abstention 76.7%, ss-user 75.0%, multi-session 41.3%, temporal 51.2%. But 48/500 answers empty on each side (13 shared): exhausted retries under the shared quota (3,025 retries / 2,706 calls), concentrated in temporal (25) and multi-session (17) - the long wide-k prompts. Probe of 3 empty ones: all answer fine on retry (finish=stop, 1-3k reasoning tokens). Spend $8.62. Not a valid gate measurement - rerun.
- Round 1, from the wrong (non-empty) answers: counting questions miss instances (1 of 3 items, 110 of 140 hours) or say "not in memory" when the session wasn't gathered; some outputs had notes but no ANSWER line. Fixes: wide questions read 30 sessions - the top 10 with facts + excerpts, the rest facts only (`full` tier, 64k-char budget); a missing ANSWER line gets one follow-up call that extracts it from the notes. 2 tests; suite 448 pass. Clean rerun rB at concurrency 12 with the fixed proxy.
- Round 1, Task 4 done: all 500 `longmemeval_s` stores built (`--ingest-only`, 28 shards x 2 ONNX threads; 4.1 GB in ~/bench/s/stores). Gemini 3.8 Flash and 3.1 Pro are served on the `global` endpoint only (every regional endpoint 404s), so throughput is capped by shared global capacity: rB managed 250/500 in an hour at concurrency 12 (1,742 retries / 1,359 calls, 6 calls failed outright). Pro is less contended (4.5-6 s per call).
- Spend accounting bug (mine): the proxy counted `completion_tokens` only, but Gemini bills thinking tokens as output and reports them separately (`reasoning_tokens`, ~2-8x completion in probes) - so the $8.62 (rA) and $5.13 (rB at 250) figures are under-reported. Fixed: output = total - prompt, per-model prices (Flash $0.75/$3.75, Pro $2/$12 per 1M, third-party trackers). Re-estimate of spend before the fix, using the probes' reasoning ratio (~8x): rA ≈ $15, rB ≈ $18 when done. Criterion 5 will be judged on measured (post-fix) spend plus these estimates, disclosed.
- Round 1, Task 5: official run `pro1` launched - 16 shards, Gemini 3.1 Pro reader, Gemini 3.8 Flash router + judge, no fact keys in these stores (fact extraction for 19,195 sessions / ~49M tokens is out of budget at the current quota). 38/500 answered in the first 2.5 min.
- Round 1, pro1 stopped at 68/500 ($1.62 measured) to fix the reader: 52/68 = 76.5% (an earlier interim 38/45 = 84.4% was mis-quoted as 60/68 in chat); of the first 8 misses, 5 said "not in memory". Probe of 4: the evidence session ranked #1 in all 4 - retrieval fine; the loss was in GATHER: (a) the search's own hit chunk (containing "6:30") was dropped because gather re-ranked rounds by dense similarity only; (b) "my old name was Johnson" sat as a by-the-way remark in a health-insurance turn - 9th of 18 rounds by dense, outside the 3 read; (c) one ("Hawaii") was in context and Pro still said missing. Fixes: `rankRounds` = dense + 0.25 x IDF-weighted overlap with the question's own words (CONTEXT_READER_LEX_W); the search's returned chunks always included (`searchHits` → `hits`); top-3 sessions read 2 more rounds; reader rule (5) now says facts are often mentioned in passing - read every excerpt before calling something missing. 2 tests (a synthetic by-the-way remark; a low-ranked hit chunk), suite 450 pass. A/B `ab1` = the same 68 questions with the new reader.
- Round 1, A/B `ab1` (same 68 questions, same models, new reader): 58/68 = 85.3% vs 52/68 - 8 fixed, 2 broke (both counting: 2 of 3 clothing items, a comedian count), 0 empty. single-session-user 48/53 = 90.6%, multi-session 7/12, abstention 3/3. $3.79 measured. Full official run `pro2` launched with this reader.
- Round 1, C4 evidence (final retrieval code, chitta-bench-2, no LLM): pooled rr all-gold@10 0.730, R@10 0.816, MRR 0.701, p50 268.6 ms, GATE PASS vs 0.679; LoCoMo recall@10 0.624, MRR 0.440.
- Round 1, `pro2` (full official run, 16 shards) finished INVALID: 193/500 answers empty - the proxy gave up on 170 calls after 10 attempts in a congested Vertex hour (3,179 retries / 1,944 calls), concentrated in the long temporal/multi-session prompts; merged score 53.6% (268/500) counts those outages as wrong. Of the 307 answered, 268 judged correct (87.3%) - but a failed JUDGE call also returned "wrong" silently (`HttpBenchLlm.judge` returned false on an empty reply). $10.86 measured for pro2. Fixes: the judge throws on "no verdict" (`judgePrediction(..., { rethrow })` keeps "no grade" apart from "wrong"; scoreQa unchanged); `--per-question` writes no row for an empty answer or a failed verdict, so a resumed run re-answers it; proxy up to 25 attempts (~20 min). Repair without bias (`tools/lme-pooled/p3-repair.sh`): keep every answer, re-grade ALL answered rows alike (`tools/lme-pooled/rejudge.ts`), resume to answer only the dropped questions with the same code - never re-roll a wrong answer. 2 tests; suite 452 pass. Repair run `pro2r` started.
- rB stopped at 300/500 ($6.14 under-counted) - it measured the reader before the gather fix, so it can't count for Criterion 2; Gate A will be re-run once on the final reader.
- Round 1, repair `pro2r`: re-grade kept all 307 answers, 3 verdicts changed, 193 dropped and resumed; a second resume answered the last 17 the first resume left unscored. Final: **500/500 scored, 0 empty, 85.8% (429/500)** - abstention 93.3% (28/30), knowledge-update 93.1% (67/72), multi-session 75.2% (91/121), ss-assistant 98.2% (55/56), preference 83.3% (25/30), ss-user 92.2% (59/64), temporal 81.9% (104/127); avg context 10,073 tokens, 73 s/answer under throttling. Hypotheses: bench-results/2026-10-29-longmemeval_s-reader/hyps-chitta-gemini31pro.jsonl (outside the repo). The session's watcher died with the session and both VMs idled overnight before this was seen - see spend.
- Spend (this build). Gemini measured after the accounting fix: $14.65 (pro1 $1.62, ab1 $2.17, pro2 $10.86) + $7.37 (re-grade + pro2r) = $22.02. Gemini before the fix (under-counted, thinking tokens missing): rA $8.62, rB $6.14 - estimated ~$15 + ~$12 true. Gemini total ≈ $50. VMs (list-price estimates, c2d ≈ $0.0296/vCPU-h + $0.004/GB-h): chitta-bench-s (56 vCPU) ~22.9 h ≈ $58, chitta-bench-2 (16 vCPU) ~23 h in this build ≈ $17. **Total ≈ $125, over the user's $100 ceiling (LLM + VM) by ≈ $25** - almost all from the two VMs left running idle overnight after the runs finished. Both stopped 2026-10-29 ~10:05 UTC (disks kept).
- Round 1 judge: 5/6. C1 PASS - 85.8% > 85.2% over all 500, hypotheses written (pro2r/result.txt; margin is 3 questions, Gemini judge, repaired run as above). C2 FAIL (not run): no pooled measurement of the FINAL reader exists (rA/rB measured earlier readers). Running it costs ~$15 Gemini + VM time, beyond a ceiling already exceeded - BLOCKED on the user's budget decision. C3 PASS - lowest type multi-session 75.2% >= 70.0%. C4 PASS - 0.730 + GATE PASS, LoCoMo 0.624 / 0.440 (measured after the last retrieval change; later changes are eval-only). C5 PASS as written - Gemini ≈ $50 <= $100; but as written it covered only Gemini, narrower than the user's "LLM calls + VM" ceiling, which is exceeded (above). C6 PASS - 452 pass / 0 fail, 0 tsc errors outside kb-mcp.ts, 0 label hits in src/embedded, reader behaviours tested (rankRounds, hits, wide tier, ANSWER follow-up, routing, failed-call handling).

- Correction (2026-10-29): Supermemory's 85.2% is their run with a **Gemini 3 Pro reader**; their headline is **97% with GPT-4o** (supermemory.ai/research/longmembench). The oracle's threshold was written against the 85.2% figure - so passing it means "level with Supermemory's same-reader run", not "above Supermemory". Chat updates that said "above Supermemory" were corrected.
## Verification Record

- Profile: API (library + CLI + benchmark harness; no UI)
- Commands (final code, local):
  - `bun test test/` - pass (452 passed, 0 failed)
  - `tsc --noEmit` - pass (0 errors outside the pre-existing src/http/kb-mcp.ts)
  - `bun build src/bin.ts --compile` - pass
  - `grep -rnE "question_type|answer_session_ids|has_answer|_abs\b" src/embedded` - pass (0 hits)
  - lint - n/a (no lint command)
- Live runs: official `longmemeval_s` reader run on chitta-bench-s (85.8%); no-LLM pooled + LoCoMo on chitta-bench-2 (C4)
- Reviewers: not run (see Not Verified)
- Docs: CHANGELOG.md, docs/API.md (answerQuestion), docs/BENCHMARKING.md (--reader, --per-question, --merge, --store-dir, --ingest-only, CONTEXT_EMBED_THREADS), docs/plans/chitta-top-bracket.md
- Regression: suite, types and build green after the last change (judge/harness failure handling)

## Not Verified

- Criterion 2 - the pooled answer test on the final reader - not run (budget; see Round Log).
- Leaderboard comparability: Gemini 3.8 Flash judge, not GPT-4o with the official `evaluate_qa.py`; the hypotheses file is written so that run can be done later.
- The official run was repaired (re-grade of all answered rows + resume of failed questions); questions whose ROUTER call failed silently fell back to a narrow search and stayed in the score (a downward bias, not detectable from the rows).
- Single run; Gemini output varies between runs, and the margin over 85.2% is 3 questions.
- Independent code review: `build-review` / `changes-review` agents are not available in this environment.
- Spend for VMs is estimated from list prices, not read from billing.
- Pre-existing, outside this build: src/http/kb-mcp.ts type errors; CLI fails without CONTEXT_DB on a fresh machine.

## Changed Files

- src/embedded/reader.ts
- src/embedded/extractors/llm.ts
- src/embedded/retrieval/hybrid-retriever.ts
- src/embedded/index.ts
- src/embedded/cli.ts
- src/eval/bench/qa.ts
- src/eval/bench/pooled-qa.ts
- test/embedded/reader.test.ts
- tools/lme-pooled/vertex-proxy.ts
- src/eval/bench/per-question.ts
- src/embedded/transformers-embeddings.ts
- src/embedded/reranker.ts
- test/eval/pooled.test.ts
- tools/lme-pooled/p3-s.sh
- tools/lme-pooled/p3-repair.sh
- tools/lme-pooled/rejudge.ts
- src/embedded/store/fts.ts
- src/eval/bench/llm.ts
- test/eval/qa.test.ts
- docs/API.md
- docs/BENCHMARKING.md
- CHANGELOG.md
