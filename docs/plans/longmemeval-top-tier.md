# Chitta on LongMemEval: plan to reach the top tier

Status: Phase 0 and Phase 1 implemented and measured 2026-10-28 (uncommitted; see "Phase 0 +
1 results" below). Phases 2-6 open. Every number was measured on a GCP VM (e2-standard-8,
Bun 1.3.13, bge-small-en-v1.5 embeddings) unless marked otherwise or as a published claim.

## Phase 0 + 1 results

Same pooled store (940 sessions, 53,232 chunks), 470 answerable questions, k=10:

| Configuration | Pass (All@10) | Recall@10 | MRR@10 |
|---|---|---|---|
| Chitta before, as shipped (reranker on) | 59.1% | 0.694 | 0.675 |
| **Chitta after, new defaults (reranker on)** | **70.0%** | **0.798** | 0.661 |
| Chitta after, no reranker | 67.2% | 0.776 | 0.651 |
| BM25 + dense RRF baseline | 67.7% | 0.772 | 0.652 |

The gate passes with the shipped defaults (70.0% vs 67.7%); without the reranker Chitta is
0.5 points under the baseline. MRR is a little below the old shipped config because the reranker
now blends with the fused order (best recall) instead of replacing it (best MRR).

LoCoMo (10 conversations, 1,540 questions; old = the code before this work, which reproduces the
README's 0.552):

| | Recall@10 | MRR |
|---|---|---|
| Old, reranker on | 0.552 | 0.408 |
| **New, reranker on** | **0.624** | **0.439** |
| Old, no reranker | 0.556 | 0.243 |
| **New, no reranker** | **0.647** | **0.458** |

Latency p50 with the reranker, each run alone: 876 ms on the VM, 419 ms on an M3 Pro (whose
p95 was 4.8 s while the machine was swapping). Without the reranker roughly 270 ms on the VM.

What each change was worth (pooled all-gold@10 unless stated):

- Retrieval no longer boosts its own results (salience): +7.9 (no reranker).
- 10 distinct sessions from a 400-chunk pool: +5.7.
- Write-time `importance` taken out of the ranking (`CONTEXT_IMPORTANCE_W`, default 0): +3.2
  without the reranker, +0.9 with it; LoCoMo MRR without reranker 0.337 -> 0.458. Its cue words
  ("important", "must", "deal") fire at random on chat and multiplied scores by up to ~2.6.
- Blended reranker over 50 candidates, one per session: +2.8 over no reranker.
- Keyword search with porter stemming + stopwords: +0.6 fused (the keyword leg alone +1.7).
- Recency in whole days instead of milliseconds: no measurable change; kept because
  millisecond factors break exact score ties by storage order.
- Graph leg (`CONTEXT_GRAPH=0` to turn off): neutral on both benchmarks (69.1 vs 69.1 pooled,
  0.622 vs 0.622 LoCoMo recall). Left ON pending a product decision; see 1.6.
- Relative cutoff: no effect; kept (it only applies without the reranker, and keeps junk out of
  small stores).
- Tried and rejected: ranking each signal by session position instead of chunk position
  (62.1% vs 69.1%) - it gives every graph-leg session a high rank, so graph noise competes at
  full strength.

## 1. Where Chitta stands

**Pooled test.** All 940 evidence sessions from `longmemeval_oracle.json` go into ONE store
(53,232 chunks). Each of the 470 non-abstention questions must find its gold sessions among all
940. A question passes when all of its gold sessions are in the top 10.

| Method | Pass (All@10) | Recall@10 | MRR@10 | p50 latency |
|---|---|---|---|---|
| BM25 + dense, RRF | **67.7%** | 0.772 | 0.652 | 47 ms |
| Dense only | 64.5% | 0.741 | 0.614 | 44 ms |
| BM25 only | 60.4% | 0.699 | 0.624 | 3 ms |
| Chitta, benchmarked without the reranker | 53.0% | 0.641 | 0.476 | 267 ms |
| Chitta + PPR graph walk | 52.6% | 0.639 | 0.465 | 282 ms |
| Chitta as shipped (reranker on) | 59.1% | 0.694 | 0.675 | see Phase 1 |

The three baselines rank Chitta's own chunks with Chitta's own embeddings, so the gap is
ranking logic alone. Chitta loses on every question type; the widest gaps are temporal
(35% vs 54%) and multi-session (31% vs 45%). PPR won zero questions.

The ablations in section 4 (Phase 1) show the gap is mostly configuration: with four env
changes and its own reranker, Chitta reaches 70.4% and beats the baseline.

## 2. What "top tier" means

- The scores people compare are **end-to-end answer accuracy** on `longmemeval_s` (about 50
  sessions, ~115k tokens per question): an LLM reads the retrieved memory, answers, and GPT-4o
  judges the answer.
- Published claims, all self-reported and run with different readers and judges, so read
  them as a band, not a ranking: Mastra Observational Memory 94.87% (gpt-5-mini reader,
  gemini-2.5-flash observer, no retrieval at all), Hindsight 91.4%, EmergenceMem 86.0%,
  Supermemory 85.2%, Zep 71.2%.
- Chitta has **never published an answer-accuracy number**. The README's 0.782 is retrieval
  recall on the oracle file, where each question searches only its own 1-6 sessions.
- Every system in the top band spends an LLM at ingest (dated facts or observations) and uses
  a strong reader. Zero-LLM retrieval alone will not reach 90%+. The realistic position is:
  best retrieval layer by default, top-band accuracy in an opt-in LLM mode, with ACL scoping
  that the others do not have.

**Gates**

| Gate | Measure | Target |
|---|---|---|
| G1 | Pooled All@10 | >= 0.80 (beats RRF's 0.677) at p50 <= 100 ms |
| G2 | `longmemeval_m` session Recall@10 | >= 0.86 (the LongMemEval paper's best: Stella 1.5B + fact-expanded keys) |
| G3 | `longmemeval_s` answer accuracy, GPT-4o judge, official prompt | >= 90% with a gpt-4o-mini-class reader; >= 94% with a strong reader |

## 3. Root causes found in the code

1. **The benchmark did not use the reranker.** The MCP server turns on the cross-encoder by
   default (`src/embedded/personal.ts`, `pickReranker`), but `buildEmbeddedContext({ path })`
   leaves it off. The reranker also fails silently (no-op) if its model cannot load.
2. **Retrieval rewrites ranking.** Every search calls `touchRecords`
   (`retrieval/diversity.ts`), and `decayStage` boosts records by access count
   (`retrieval/decay-stage.ts`). Earlier questions bias later ones; in production, whatever was
   retrieved once keeps winning.
3. **The 30% relative cutoff** (`CONTEXT_RRF_RATIO`) looked like it would drop single-signal
   hits past roughly rank 7. Measured: no effect on this test.
4. **Chunk-level fusion with a small pool.** Each signal contributes 80 chunks (`topk * 8`);
   the median session has 37 chunks, so a few sessions fill the pool. With at most 2 chunks
   per session and 10 chunks returned, Chitta shows about 7.8 sessions per question, against
   the baselines' 10.
5. **Chunks lose their context.** Only 940 of 53,232 chunks (1.8%) carry the session date;
   90% have no speaker label; 25% are under 100 characters. `chunkText`
   (`src/embedded/ingest.ts`) splits on blank lines and never merges small paragraphs up to
   its 512-character size, so assistant markdown becomes many tiny fragments.
6. **Keyword search keeps stopwords and has no stemming** (`store/fts.ts`): every token,
   including "what", "did", "my", is OR-ed into the FTS5 query.
7. **Graph legs add little on chat.** The deterministic extractor finds few entities in casual
   conversation; PPR measured zero wins; the 1-hop graph leg has no off switch to measure it.
8. **No time awareness or question-type handling at query time.**
9. **Latency is 5-6x the baselines** (267 ms vs 47 ms p50).

## 4. Steps, in order

### Phase 0: measure the right thing

- [x] 0.1 Build the benchmark's Chitta with the same factory as the server (`personal.ts`
      `serverPipeline`), reranker included; the run fails if the reranker did not load. The
      server's `pickEmbeddings` now resolves exactly like `defaultEmbeddings` (it ignored
      `CONTEXT_EMBEDDINGS=real` and `CONTEXT_EMBED_PROFILE`).
- [x] 0.2 `chitta bench longmemeval --pooled` (`src/eval/bench/pooled.ts`): BM25, dense and RRF
      baselines over the same chunks in the same run; exits 1 when Chitta < RRF. Not in GitHub
      CI: it needs the dataset, the model and a ~35 min ingest - run it on a VM (appendix).
- [x] 0.3 Done structurally: retrieval is read-only now (1.1), and the pooled run fails if any
      salience is written during the query phase.
- [~] 0.4 Implemented, not run: the reader gets `question_date`, the judge applies LongMemEval's
      per-type rules, and `--hyps` writes answers for the official `evaluate_qa.py`. Running it
      needs an LLM endpoint + key and GPT-4o judge calls (cost).
- [x] 0.5 `tools/lme-pooled/` (runners + experiments used for every number here).

### Phase 1: retrieval fixes (ablation-backed)

Measured with env knobs only (no code changes), each run on a fresh copy of the store:

| Configuration | Pass (All@10) | Recall@10 | MRR@10 |
|---|---|---|---|
| Chitta, benchmarked without the reranker | 53.0% | 0.641 | 0.476 |
| **Chitta as shipped** (server default: reranker on) | 59.1% | 0.694 | 0.675 |
| No reranker, salience off (`CONTEXT_DECAY=0`) | 60.9% | 0.708 | 0.640 |
| ... plus relative cutoff off (`CONTEXT_RRF_RATIO=0`) | 60.9% | 0.708 | 0.640 |
| ... plus 10 distinct sessions (fetch 40 chunks, keep first 10 sessions) | 66.8% | 0.762 | 0.648 |
| All fixes: salience off, cutoff off, 1 chunk per session, pool 400 | 66.6% | 0.759 | 0.644 |
| All fixes + reranker, replace order (top 50) | 69.6% | 0.790 | **0.722** |
| **All fixes + reranker, blended with RRF order (top 50)** | **70.4%** | **0.796** | 0.686 |
| BM25 + dense RRF baseline | 67.7% | 0.772 | 0.652 |

- Salience self-boost is the largest single defect: turning it off is worth +7.9 points.
- Showing 10 distinct sessions is worth +5.9 points at the same token cost (~275 tokens).
- The relative cutoff changed nothing.
- The reranker is worth +6.1 points on the shipped config and +3.8 on the fixed one. Blend
  gives the best recall, replace gives the best MRR.
- Fixed Chitta beats the baseline 70.4% to 67.7% (head to head: 29 questions only Chitta
  passes, 16 only the baseline passes). By type, best config vs baseline: single-session-user
  93.8 vs 87.5, multi-session 50.4 vs 44.6, temporal 57.5 vs 53.5, knowledge-update 91.7 vs
  91.7, single-session-assistant 100 vs 100, preference 50.0 vs 60.0.
- 123 questions are still failed by both. That is the work for Phases 2 and 3.

Latency, each config run alone on the VM (same accuracy as the parallel runs, so the results
are deterministic): all fixes without the reranker p50 **269 ms** / p95 338 ms (unchanged from
before the fixes); all fixes + blended reranker p50 **810 ms** / p95 1,216 ms. Reranking 50
candidates costs ~0.5 s per question on e2-standard-8 CPU; Phase 5 has to win that back
(rerank one passage per record, fewer candidates, a quantized model).

Steps, ordered by measured gain:

- [x] 1.1 Retrieval no longer records an access; `markUsed` (ACL-scoped) counts a real use, and
      `chitta ask` calls it for the sources its answer cites. Access boost capped at x1.15.
- [x] 1.2 K distinct sessions: distinct records first, extra chunks per record only as backfill;
      400-chunk pool. (Session-position fusion was tried and rejected - see results.)
- [x] 1.3 Reranker defaults: 50 candidates, one per session, blended with the fused order.
- [ ] 1.4 Preference questions: 46.7% -> 53.3% once importance left the ranking, still below
      dense-only 60%. Open; next look at what the cross-encoder does with advice questions.
- [x] 1.5 FTS: porter stemming, stopword list, deduplicated terms; old stores rebuild their
      keyword index once on open.
- [~] 1.6 `CONTEXT_GRAPH=0` added and measured: neutral on both benchmarks. Kept ON: dropping it
      is a product call (Chitta is sold as graph memory; document stores are unmeasured).
- [x] 1.7 Relative cutoff kept, not dropped: no effect here, but it filters junk in small stores
      when the reranker is off.
- [x] 1.8 (found while measuring) Write-time importance out of the ranking by default
      (`CONTEXT_IMPORTANCE_W=0`; the old behaviour is `=1`). +3.2 / +0.9 points.
- [x] 1.9 (found while measuring) Recency in whole days, so exact score ties keep the fused order.

### Phase 2: indexing (largest expected gain)

- [ ] 2.1 Contextual chunk header: every chunk is embedded and indexed with
      `[session date | session id | speaker]`, and the date is stored as a column for filtering.
- [ ] 2.2 Round-level units: one user turn plus the assistant's reply. Split long replies, but
      repeat the user turn as each piece's header. Merge small paragraphs up to the size limit.
- [ ] 2.3 Fact-augmented keys (opt-in LLM mode): extract dated user facts per round ("2023-05-20:
      user bought a Mazda CX-5") and index them as extra keys that point to the round. The
      LongMemEval paper reports +9.4% recall@k and +5.4% accuracy on average. Build on the
      existing HybridExtractor and memories layer.
- [ ] 2.4 Embedder bake-off on the pooled test: bge-small (current), bge-base,
      embeddinggemma-300m, gte-modernbert-base, Stella 1.5B (the paper's), and one API model.
      Keep a small default and offer an "accurate" preset. The earlier "bge-base did not help"
      result was on LoCoMo, not this test.

### Phase 3: query understanding

- [ ] 3.1 Time-aware retrieval: parse the question date and relative expressions ("last month",
      "two weeks ago", "first ... after") into a date range, then filter or boost on the session
      date column (needs 2.1). The paper reports temporal Recall@10 0.55 -> 0.72 with GPT-4o
      expansion; a deterministic parser first, LLM optional.
- [ ] 3.2 Question-type router: aggregation ("how many", "total") -> larger K plus multi-query;
      ordering ("which first", "before/after") -> retrieve each named event separately and
      union; update ("current", "now", "still") -> prefer the latest session per topic;
      preference ("recommend", "suggest") -> include profile facts.
- [ ] 3.3 Multi-query decomposition (LLM optional), fused with RRF across sub-queries.
- [ ] 3.4 Abstention: expose a confidence score so the reader can answer "not in memory".

### Phase 4: answering (needed to compete on accuracy)

- [ ] 4.1 Reader prompt: evidence sorted by date with dates shown, the question date given,
      Chain-of-Note, then a JSON answer. The paper measured up to a 10-point drop from a weak
      reading strategy.
- [ ] 4.2 Observation mode (opt-in): a background LLM turns each session into dated
      observations and a reflector merges them (the approach of the current leader), kept as a
      stable, cacheable prefix, with retrieval over raw rounds as fallback. Build it on the
      memories layer (`memory/consolidate.ts`) so ACL scoping still applies.
- [ ] 4.3 Report accuracy and tokens per question side by side (Chitta's angle is accuracy
      at low token cost).

### Phase 5: speed

- [ ] 5.1 Profile per stage and get p50 <= 100 ms at 50k chunks without the reranker (269 ms
      today, baselines 47 ms). Suspects: per-query graph-stage SQL, salience/decay queries,
      stopword-heavy FTS queries.
- [ ] 5.2 Make the reranker affordable (+0.5 s today): rerank one best passage per record
      (10-20 inputs, not 50 chunks), use the quantized ONNX model, cap passage length.

### Phase 6: honest claims

- [ ] 6.1 Replace the README's 0.782 framing with the pooled and Tier B numbers, stating
      dataset, reader and judge.
- [ ] 6.2 Mark PPR as experimental: it measured neutral on LoCoMo and on this test.

## 5. Expected path

- Phase 0 + 1: done. Pooled pass rate 59.1% (as shipped) -> 70.0%; LoCoMo recall 0.552 -> 0.624.
- Phase 2 + 3 (2026-10-28, build `docs/builds/2026-10-28-chitta-memory-benchmarks-phase2.md`):
  zero-LLM 70.0% -> 73.0% (round chunks +1.7, time-aware +0.7, compound sub-queries +0.7);
  LLM mode with Gemini fact keys 78.5%, plus LLM query rewriting 82.3% - **G1 (>= 0.80) met in LLM
  mode**. First end-to-end answer accuracy on the pooled store: 49.4% (Gemini reader + judge, one
  chunk per session) vs 46.2% from the RRF baseline's context. The remaining gap is reading, not
  retrieval - continued in `docs/plans/chitta-top-bracket.md`.
  Done items: 2.1 (date headers), 2.2 (round chunks), 2.3 (fact keys), 3.1 (time), 3.3 (compound
  sub-queries); 2.4 partly (BGE query instruction and CLS pooling measured, not adopted).
- Phase 2.1-2.2 + 3.1: aimed at G1 (>= 0.80 pooled). Not yet measured; the evidence is the
  LongMemEval paper and the chunk statistics above.
- Phase 2.3 + 3 + 4: aimed at G2 and G3. Needs an LLM at ingest and a strong reader, like every
  system in the top band.

## Appendix: rerunning the pooled test on GCP

The scripts are in `tools/lme-pooled/` (put `longmemeval_oracle.json` next to them, or set
`LME_DATA`): `lme-ingest.ts` (ingest all sessions), `lme-query.ts` (baselines / chitta /
chitta-ppr), `lme-ablate.ts` (Chitta with env knobs, `RERANK=1`, `FETCH=n`),
`lme-score.ts`, `lme-diff.ts`, `check-emb.ts` (proves real 384-d embeddings),
`chunk-stats.ts`, `fts-exp.ts` (keyword leg variants), and the runners `run.sh` (full pass),
`ablate.sh` (env ablations), `after.sh` / `final.sh` / `w0.sh` (the Phase 0+1 measurements).
For new runs prefer the built-in command: `chitta bench longmemeval --pooled` (docs/BENCHMARKING.md).

- VM: `chitta-lme-bench`, project `<gcp-project>`, zone `us-east1-b`.
- SSH works only through IAP: `gcloud compute ssh chitta-lme-bench --zone us-east1-b --tunnel-through-iap`.
- Full ingest: ~2.2 s per session on e2-standard-8 (~35 min for 940 sessions); queries take
  minutes. Copy `node_modules/@huggingface/transformers/.cache/Xenova/{bge-small-en-v1.5,ms-marco-MiniLM-L-6-v2}`
  to the VM so it uses the same model files.
