# Chitta Memory Benchmarks Phase 2 Buildout

Created: 2026-10-28
Agent: Claude Code
Status: VERIFIED
Approved: Yes
Rounds: 2
Worktree: No
Type: Build

## Summary

**Goal:** Push Chitta's memory benchmarks past the Phase 0/1 result (pooled LongMemEval all-gold@10 0.700, LoCoMo recall@10 0.624) toward the plan's G1 (>= 0.80), and produce a first end-to-end answer-accuracy number - through general retrieval improvements (Phases 2-4 of `docs/plans/longmemeval-top-tier.md`), not benchmark tricks.

**Oracle:** `chitta bench longmemeval --pooled` on the 940-session oracle pool reports Chitta all-gold@10 >= 0.800 with the LLM mode on (CONTEXT_LLM_URL set, as the competitors run) - the plan's G1.

**Misfire:** The numbers rise through benchmark-shaped hacks (reading LongMemEval labels or phrasing at query time) or by making the score depend on the LLM while the zero-LLM product regresses, or while LoCoMo (never tuned on) gets worse. Caught by Criteria 2, 3 and 5.

**Constraints:** Work on the current branch (`main` working tree, on top of the uncommitted Phase 0/1 changes). Zero-LLM stays the default; LLM features are opt-in via CONTEXT_LLM_URL. ACL scoping must hold for every new index (fact keys inherit the record's permissions). Benchmarks run on a new c2d-standard-16 GCP VM (deleted at the end); LLM = gemini-3.8-flash via Vertex on project <gcp-project> (~a few dollars).

**Assumed:** The leaderboard-comparable answer number (longmemeval_s, ~25k sessions, ~15 h of CPU embedding) is out of reach in this session; the answer-accuracy number is measured on the pooled store with Gemini as reader and judge - internal, not leaderboard-comparable. The `build-review` / `changes-review` agents are not available in this environment (not in the agent list), so neither reviewer runs; disclosed in Not Verified.

## Acceptance Criteria

- [x] Criterion 1 (oracle): `chitta bench longmemeval --pooled` with CONTEXT_LLM_URL set reports chitta all-gold@10 >= 0.800 on the 940-session pool (log line quoted in the Round Log).
- [x] Criterion 2: The same command with no LLM (zero-token default) reports chitta all-gold@10 > 0.700 and `GATE PASS`.
- [x] Criterion 3: `chitta bench locomo --tier a --k 10` (zero-LLM default, reranker on) reports overall recall@10 >= 0.624 and MRR >= 0.439.
- [x] Criterion 4: On the pooled store, Gemini answering from Chitta's top-10 context scores higher accuracy than Gemini answering from the BM25+dense RRF top-10 context, same reader and judge, all 500 questions, per-type table and hypotheses file written.
- [x] Criterion 5: No retrieval code under `src/embedded/` reads dataset labels (`question_type`, `answer_session_ids`, `_abs`, `has_answer`) - grep shows none - and every new retrieval/ingest behaviour has a unit test on non-benchmark text.
- [x] Criterion 6: Zero-LLM pooled p50 latency with the reranker, measured on the same VM in the same session, is <= 1.15x the Phase-1 build's p50.
- [x] Criterion 7: `bun test test/` passes with 0 failures and `tsc --noEmit` shows no errors outside the pre-existing `src/http/kb-mcp.ts`.

## Progress Tracking

- [x] Task 1: Stand up the VM and re-baseline Phase 1 on it
- [x] Task 2: Contextual, round-level chunks
- [x] Task 3: Query-side time and decomposition handling
- [x] Task 4: LLM fact keys at ingest (Gemini via Vertex)
- [x] Task 5: Answer-accuracy benchmark on the pooled store
- [x] Task 6: Docs, plan and changelog
- [x] Task 7: Split only genuinely compound questions (LoCoMo regression)
- [x] Task 8: Re-run the answer-accuracy benchmark on the final code

## Implementation Tasks

### Task 1: Stand up the VM and re-baseline Phase 1 on it

**Objective:** Create a c2d-standard-16 VM (cloud-platform scope so it can call Vertex), copy the current code, model files and data, and re-run the Phase 1 build's pooled (zero-LLM, reranker on/off) and LoCoMo numbers plus a solo latency run, so every later number is compared on the same machine.

### Task 2: Contextual, round-level chunks

**Objective:** Make every chunk carry its session date and speaker, and group a user turn with the assistant's reply instead of splitting on every blank line (plan 2.1 + 2.2), so a chunk is a self-contained, dated unit; re-ingest and measure on both benchmarks.

### Task 3: Query-side time and decomposition handling

**Objective:** Use dates at query time (relative-time expressions against the record date) and split compound questions ("X or Y first", "and") into sub-queries fused back together (plan 3.1-3.3), plus whatever the per-type failures show is worth fixing (preferences, 1.4); measure each.

### Task 4: LLM fact keys at ingest (Gemini via Vertex)

**Objective:** In LLM mode, extract dated user facts per round at ingest and index them as extra search keys that point back to their record (plan 2.3), ACL-scoped like the record; measure the pooled number with Gemini.

### Task 5: Answer-accuracy benchmark on the pooled store

**Objective:** Answer all 500 pooled questions with Gemini from Chitta's top-10 context and, separately, from the RRF baseline's top-10, judge both with the per-type rules, and write per-type accuracy plus hypotheses files.

### Task 7: Split only genuinely compound questions (LoCoMo regression)

**Objective:** LoCoMo recall fell 0.624 -> 0.623 with sub-queries on (0.624 with them off). Split a question only when it has two or more parts; a single quoted title is already in the main query.

### Task 8: Re-run the answer-accuracy benchmark on the final code

**Objective:** Criterion 4's evidence came from code before query expansion, the compound-only fix and the import fix. Re-run `--pooled --answer` on the LLM store with the final code so the verdict rests on the finished artifact.

### Task 6: Docs, plan and changelog

**Objective:** Record what each change was worth in `docs/plans/longmemeval-top-tier.md`, the CHANGELOG and docs/BENCHMARKING.md, so the numbers and new options are discoverable.

## Round Log

- Round 1, Task 1: VM `chitta-bench-2` (c2d-standard-16, cloud-platform scope). Phase-1 build (`~/chitta-p1`) on the Phase-1 store: pooled rr all-gold@10 0.700, p50 328.0 ms / p95 435.2 ms (solo) -> Criterion 6 ceiling 377 ms; pooled norr 0.672; LoCoMo rr 0.624 / MRR 0.439; LoCoMo norr 0.647 / MRR 0.458. All identical to the e2 VM.
- Round 1, Task 2 experiment E1 (bge query instruction, query-side only): chitta 0.691 (-0.9) while the plain RRF baseline rose 0.677 -> 0.691. Not adopted (stays opt-in, off).
- Round 1, Task 4: first LLM-mode build (facts + LLM triples inside ingest, 8 sessions at a time) ran at ~2.8 sessions/min (~5 h) - stopped. Redesigned: fact keys extracted up front (16 Gemini calls at once, cached in `<store>.facts.json`) and passed in as `facts`; graph extraction deterministic in this run (`CONTEXT_POOLED_LLM_TRIPLES=1` re-enables LLM triples). This is the LLM configuration Criterion 1 is measured under.
- Round 1, Task 2: round-level chunks + date headers + batched embedding (E2, fresh store, 16,396 chunks vs 53,232): pooled rr 0.717 (MRR 0.687), multi-session 0.537 (was 0.471), temporal 0.598. CLS pooling on the same chunks (E3): 0.715 - no gain, knob removed with the query instruction. Preference 0.533 -> 0.433 (4 questions fell out of the top 10, several others rose to rank 1).
- Round 1, Task 3: on the E2 store, time-aware boost + sub-queries: all 0.730 / MRR 0.704; time off 0.723; sub-queries off 0.723 (each worth +0.7, additive). Temporal 0.622, preference 0.467. Preference stays the weakest type; left to the fact keys (Task 4).
- Round 1, Task 4: LLM mode (llm2 store: rounds + 8,816 Gemini fact keys for 940 sessions, 993 calls / 10 retries; time + sub-queries on): pooled rr 0.785 (R@10 0.860, MRR 0.768), norr 0.764; RRF on the same store 0.762. Multi-session 0.645, temporal 0.717, preference 0.467 (unchanged). 1.5 points short of the oracle.
- Round 1, LoCoMo with the final code: rr 0.623 / MRR 0.439, norr 0.646 / 0.457. The 0.001 recall drop vs 0.624 is one temporal question; batched vectors are bit-identical to single ones (probe: max diff 0), the date header is not added for LoCoMo (its turn text already carries the date) - diagnosing time vs sub-queries.
- Round 1, added: LLM query expansion (LLM mode only, `CONTEXT_LLM_EXPAND=0` off) - the model rewrites the question into up to 3 searches, fused like sub-queries. Measuring on the llm2 store.
- Round 1, expansion result (llm2 store, contended latency): rr all-gold@10 0.823, R@10 0.890, MRR 0.767; preference 0.467 -> 0.700, multi-session 0.694, temporal 0.732; p50 4.2 s (one Gemini call per search).
- Round 1, Task 5: `bench longmemeval --pooled --answer` on the llm2 store (pre-expansion code), Gemini 3.8 Flash reader + judge, 500 questions, one chunk per record: Chitta 49.4% vs RRF 46.2% (abstention 70.0/73.3, knowledge-update 56.9/52.8, multi-session 28.1/24.8, ss-assistant 62.5/60.7, preference 16.7/20.0, ss-user 78.1/68.8, temporal 48.0/44.9); context 1,294 vs 1,109 tokens. Hypotheses in ~/bench/qa/hyps-{chitta,rrf}.jsonl.
- Round 1, Task 7: LoCoMo diagnosis - sub-queries off 0.624, time off 0.623, so sub-queries cost the question. Fix: split only questions with 2+ parts (40/500 LongMemEval questions still split, was 55). Unit test added. Final batch (`tools/lme-pooled/p2-final.sh`) measuring.
- Round 1 final batch (final code): zero-LLM rr 0.730, R@10 0.816, MRR 0.701, p50 276.4 ms / p95 416.3 ms run alone, GATE PASS vs 0.679; zero-LLM norr 0.674 (gate fails without the reranker, not a criterion); LoCoMo rr recall 0.624 / MRR 0.440, norr 0.647 / 0.458; LLM mode rr 0.817 (R@10 0.892, MRR 0.775; preference 0.733, multi-session 0.686, temporal 0.709), GATE PASS vs 0.762, p50 4.6 s / p95 48 s (Gemini rewrite call, retries). Build check: `bun build src/bin.ts --compile` failed on a pre-existing literal `import("@xenova/transformers")` in a file this run touched - fixed (specifier in a variable); compiles, binary runs with CONTEXT_DB set.
- Round 1 judge: 6/7 pass. C1 0.817 >= 0.800 (final2/llm-rr.log); C2 0.730 > 0.700 + GATE PASS (final2/zero-rr.log); C3 0.624 >= 0.624, 0.440 >= 0.439 (final2/locomo-rr.log); C5 grep over src/embedded finds no dataset labels, tests: conversation-chunks, time-stage (time, sub-queries, compound-only, expansion), fact-keys (ACL, extractFacts, dated passages, SDK), mcp/context-ingest, pooled (+answer); C6 276.4 <= 377 ms; C7 439 pass, 0 tsc errors outside kb-mcp.ts. **C4 fails on stale evidence**: its 49.4% vs 46.2% run used code before expansion, the compound fix and the import fix - next round: Task 8.

- Round 2, Task 8: Vertex latency rose to 15-20 s per call (2-5 s earlier), so the answer run now searches 8 questions at once and answers/judges 16 at once (retrieval is read-only). Final code, llm2 store, LLM mode with query rewriting: Chitta 51.2% vs RRF 45.0% (abstention 80.0/66.7, knowledge-update 55.6/50.0, multi-session 28.9/24.0, ss-assistant 66.1/57.1, preference 10.0/13.3, ss-user 81.3/75.0, temporal 51.2/44.1); 500 hypotheses each in ~/bench/qa2/hyps-{chitta,rrf}.jsonl.
- Round 2 judge: 7/7 pass. C4 51.2% > 45.0% (~/bench/qa2/qa.log). C1-C3, C5-C7 unchanged since round 1 (no retrieval/ingest code changed after round 1 apart from the benchmark's concurrency and the import fix; suite, types and build re-run green after them).

## Verification Record

- Profile: API (library + CLI + MCP server, no UI)
- Live target: VM `chitta-bench-2` running the CLI on the final code; identity re-asserted before the final runs (synced source contains `questionParts` and the variable import specifiers)
- Commands:
  - `bun test test/` - pass (439 passed, 0 failed)
  - `tsc --noEmit` - pass (0 errors outside the pre-existing src/http/kb-mcp.ts)
  - `bun build src/bin.ts --compile` (VM, Linux) - pass (after fixing the pre-existing literal `import("@xenova/transformers")`)
  - compiled binary `query` with CONTEXT_DB set - pass (runs, prints its commands)
  - lint - n/a (package.json has no lint command)
- Benchmarks (final code, same VM): pooled zero-LLM rr 0.730 GATE PASS, p50 276.4 ms; LLM mode rr 0.817 GATE PASS; LoCoMo rr 0.624 / MRR 0.440; answer accuracy 51.2% vs 45.0%
- Reviewers: not run - see Not Verified
- Docs: CHANGELOG.md, docs/BENCHMARKING.md, docs/API.md, docs/plans/longmemeval-top-tier.md, docs/plans/chitta-top-bracket.md
- Regression: suite, types and build re-run green after the last change (answer-run concurrency)

## Not Verified

- Independent code review: the `build-review` and `changes-review` agents are not available in this environment (not in the agent list), so neither the criteria nor the diff had a second reviewer.
- Lint: the project defines no lint command.
- User-facing UI paths: none (API profile).
- Leaderboard comparability: answer accuracy is Gemini-judged on the pooled store, not `longmemeval_s` with GPT-4o; it is not comparable with published claims.
- LLM-mode numbers are single runs; Gemini output varies between runs (0.823 vs 0.817 on near-identical code). LLM-mode latency (p50 4.6 s, p95 48 s) depends on Vertex and is not a criterion.
- Pre-existing, outside this build: the CLI fails with SQLITE_CANTOPEN when CONTEXT_DB is unset and ~/.local/share/100xprompt doesn't exist; src/http/kb-mcp.ts (another agent's untracked file) has type errors.
- The MCP endpoint test timed out once under heavy local load (load average ~70); it passed 3/3 on rerun and in every later full run.
- Pilot Console does not display this Buildout: the session's project root is ~/Desktop/lms and the work is in another repository.

## Changed Files

- src/provider.ts
- src/embedded/transformers-embeddings.ts
- src/embedded/ingest.ts
- src/embedded/index.ts
- src/embedded/extractors/llm.ts
- src/embedded/cli.ts
- src/embedded/retrieval/time-stage.ts
- src/embedded/retrieval/hybrid-retriever.ts
- src/embedded/retrieval/passage.ts
- src/embedded/retrieval/diversity.ts
- src/mcp/tools/context-ingest.ts
- src/sdk.ts
- docs/API.md
- docs/BENCHMARKING.md
- docs/plans/chitta-top-bracket.md
- docs/plans/longmemeval-top-tier.md
- CHANGELOG.md
- src/eval/bench/ingest.ts
- src/eval/bench/pooled.ts
- src/eval/bench/pooled-qa.ts
- src/eval/bench/qa.ts
- src/eval/bench/types.ts
- src/eval/bench/retrieval.ts
- src/eval/datasets/types.ts
- test/embedded/conversation-chunks.test.ts
- test/embedded/time-stage.test.ts
- test/embedded/fact-keys.test.ts
- test/eval/pooled.test.ts
- test/mcp/context-ingest.test.ts
- tools/lme-pooled/p2-query.sh
- tools/lme-pooled/p2-final.sh
- tools/lme-pooled/p2-baseline.sh
- tools/lme-pooled/p2-fresh.sh
- tools/lme-pooled/vertex-proxy.ts
- tools/lme-pooled/facts-probe.ts
