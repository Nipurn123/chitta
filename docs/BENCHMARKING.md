# Benchmarking Chitta

Chitta ships a real memory-benchmark framework, not a demo script. It measures the memory
layer the way the field does: **end-to-end QA over a long history**, broken down by the *kind*
of memory reasoning - so you learn *what* is strong or weak, not one blended number.

```
long history ──ingest──▶ [Chitta] ──get_context──▶ evidence ──answer LLM──▶ answer ──judge──▶ score
```

## Two tiers

| Tier | What it measures | Needs an LLM? | Metrics |
|---|---|---|---|
| **A - retrieval** | did the memory surface the right evidence? | No | recall@k, nDCG@k, MRR, P@k |
| **B - end-to-end QA** | can an LLM answer correctly from what was retrieved? | Yes (answer + judge) | accuracy per category |

Always look at **both**: if Tier B is low but Tier A recall is high, the failure is the answer
LLM, not the memory. Tier A is deterministic and free - run it constantly as a regression gate.

## Quick start (offline, no download)

A built-in **synthetic** dataset exercises all five categories (including a job change and a
move → *knowledge-update*, and before/after → *temporal*), so the framework runs with zero setup:

```bash
chitta bench synthetic                 # Tier A (retrieval only) - deterministic, no LLM
chitta bench synthetic --tier both     # + Tier B (needs CONTEXT_LLM_URL; see below)
chitta bench synthetic --k 10 --report scorecard.md
```

Example Tier-A scorecard:

```
Tier A - retrieval
  category             n   recall    nDCG     MRR       P
  overall             10    1.000   0.597   0.458   0.280
  temporal             2    1.000   0.825   0.750   0.400
  knowledge-update     4    1.000   0.598   0.458   0.267
  ...
```

## The real datasets

For a publishable number, run the standard long-term-memory benchmarks. Download them, then
point the loader at the JSON:

- **LongMemEval** (recommended - cleaner, category-labeled): [`xiaowu0162/LongMemEval`](https://github.com/xiaowu0162/LongMemEval). 500 questions across information-extraction, multi-session, **temporal-reasoning**, **knowledge-update**, and **abstention** - which map directly onto Chitta's Stage 3-4 features.
- **LoCoMo** ([`snap-research/locomo`](https://github.com/snap-research/locomo)): ~50 very long dialogues. Mem0/Zep publish LoCoMo numbers, so it's good for head-to-head comparison.

```bash
chitta bench longmemeval --path ./longmemeval_s.json --tier both --limit 50
chitta bench locomo      --path ./locomo10.json      --tier both
```

## Running Tier B (end-to-end)

Tier B needs an OpenAI-compatible endpoint for the answer model and the judge:

```bash
export CONTEXT_LLM_URL=https://api.openai.com     # or any OpenAI-compatible base URL
export CONTEXT_LLM_KEY=sk-...                      # optional, if the endpoint needs auth
export CONTEXT_LLM_MODEL=gpt-4o-mini               # default answer + judge model
export CONTEXT_EMBEDDINGS=real                     # IMPORTANT: use real embeddings, not the hash fallback
chitta bench longmemeval --path ./longmemeval_s.json --tier both
```

Without `CONTEXT_LLM_URL`, `--tier both` degrades to Tier A with a note.

## Benchmark mode: zero-token vs with-LLM extraction

Chitta's **default is zero-token** - a deterministic extractor pulls typed relations with no LLM.
On casual conversation (LoCoMo/LongMemEval) that extractor is naturally starved, so the graph is
thin and retrieval leans on dense+sparse. The competitors you compare against spend an LLM at
ingestion to turn chat into rich structured facts. To measure the same way, set `CONTEXT_LLM_URL`
and the benchmark ingests via the **HybridExtractor** (deterministic + LLM):

```bash
# local / sovereign model (recommended - nothing leaves the box, no per-call cost):
CONTEXT_LLM_URL=http://localhost:8000 CONTEXT_LLM_MODEL=your-model \
CONTEXT_EMBEDDINGS=transformers \
  bun run src/embedded/cli.ts bench locomo --path locomo10.json --tier a --k 10

# any OpenAI-compatible endpoint also works (a full /chat/completions URL is used verbatim);
# thinking models need CONTEXT_LLM_MAX_TOKENS >= ~1500 or the answer comes back empty.
```

Report **both** numbers - the zero-token default (what ships) and the with-LLM mode (the
head-to-head) - so the comparison is honest: accuracy *at token cost*. The LLM extraction is
thousands of calls for a full run, so start with `--limit 1` to sanity-check before a full sweep.

## Pooled LongMemEval (the realistic retrieval test + regression gate)

The standard loader gives each question its own 1-6 evidence sessions, which is easy. `--pooled`
puts EVERY session in the file into ONE store (940 for `longmemeval_oracle.json`), so each
question must find its sessions among all of them - like a real memory that has seen
everything. It runs Chitta next to three baselines that rank Chitta's own chunks with Chitta's
own embeddings (BM25, dense, BM25+dense RRF), so a gap is ranking logic, not chunking or the
model, and **exits 1 when Chitta's all-gold@k falls below plain RRF**.

```bash
chitta bench longmemeval --pooled --path longmemeval_oracle.json --store lme-pooled.db
# re-query an existing store (skips the ~35 min ingest), save per-question rankings:
chitta bench longmemeval --pooled --path longmemeval_oracle.json --store lme-pooled.db --reuse --out ranks.jsonl
```

The store is built with the server's own pipeline (reranker required to load), and the run
fails if retrieval writes salience, so no question can bias the next. A full store is ~300 MB;
`tools/lme-pooled/` has scripts for running it on a cloud VM.

**LLM mode.** With `CONTEXT_LLM_URL` set, the run first extracts fact keys for every session
(16 calls at once, cached in `<store>.facts.json` so a rebuild never pays twice) and passes them
to ingest; at query time the model also rewrites each question into up to 3 searches. Graph
extraction stays deterministic unless `CONTEXT_POOLED_LLM_TRIPLES=1` (one more sequential call
per session). On a GCE VM, `tools/lme-pooled/vertex-proxy.ts` serves Vertex Gemini as a local
OpenAI-compatible endpoint with self-refreshing tokens:

```bash
VERTEX_PROJECT=<gcp-project> bun run tools/lme-pooled/vertex-proxy.ts 8790 &
CONTEXT_LLM_URL=http://127.0.0.1:8790 CONTEXT_LLM_MODEL=google/gemini-3.8-flash CONTEXT_LLM_MAX_TOKENS=4096 \
  chitta bench longmemeval --pooled --path longmemeval_oracle.json --store lme-llm.db
```

**End-to-end answers on the pooled store.** `--answer` answers all questions (abstention
included) with the same LLM from Chitta's top-k and from the RRF baseline's top-k - one chunk per
record for both - judges them with the per-type rules, prints accuracy per question type, and
exits 1 unless Chitta's context wins. `--hyps prefix-` writes both hypotheses files.

```bash
CONTEXT_LLM_URL=... chitta bench longmemeval --pooled --answer --path longmemeval_oracle.json --store lme-llm.db --hyps hyps-
```

Add `--reader` to answer through Chitta's memory reader (`ctx.answerQuestion`: route, search,
gather dated evidence, notes-then-answer) instead of one chunk per session. Each question is routed
once and read twice by the identical reader with the identical breadth - over Chitta's sessions
and over the RRF baseline's - so only which sessions are read differs. `--reader-model` picks the
reading model (routing and judging stay on `CONTEXT_LLM_MODEL`); `--concurrency` sets questions in
flight (default 8).

**The official shape (`longmemeval_s` / `_m`).** Every question has its own ~50-session history, so
each gets a fresh store. `--per-question` ingests a question's history, answers with the memory
reader and judges it, writing one JSON line per question; it resumes past questions already in
`--out`. Embedding dominates ingest (~1 s per session on CPU), so shard it across processes and save
the stores to reuse them (`--store-dir`; `--ingest-only` builds them without any model call). Cap
each process's ONNX threads with `CONTEXT_EMBED_THREADS` when running many side by side.

```bash
# build all stores once (CPU only), e.g. 28 processes x 2 threads on 56 cores
for i in $(seq 0 27); do CONTEXT_EMBED_THREADS=2 chitta bench longmemeval --per-question --ingest-only \
  --path longmemeval_s_cleaned.json --shard $i/28 --out rows-$i.jsonl --store-dir stores & done; wait
# answer + judge (reader model separate from the router/judge model), then table the shards
for i in $(seq 0 15); do CONTEXT_LLM_URL=... chitta bench longmemeval --per-question --path longmemeval_s_cleaned.json \
  --shard $i/16 --out run/rows-$i.jsonl --store-dir stores --reader-model <model> & done; wait
chitta bench longmemeval --merge $(ls run/rows-*.jsonl | paste -sd, -)
```

`tools/lme-pooled/p3-s.sh` wraps both steps for a VM.

## Publishable LongMemEval accuracy (Tier B)

The reader is given each question's date (`question_date`), and the judge applies LongMemEval's
per-type grading rules (off-by-one tolerance for temporal counts, updated-answer rule for
knowledge updates, rubric for preferences, judge-graded abstention). For a number comparable to
published ones, also score the answers with LongMemEval's official script and GPT-4o:

```bash
chitta bench longmemeval --path longmemeval_s.json --tier both --hyps hyps.jsonl
cd LongMemEval/src/evaluation && python3 evaluate_qa.py gpt-4o /path/to/hyps.jsonl /path/to/longmemeval_s.json
```

## Fairness (so the number means something)

1. **Turn on the real pipeline.** The hash embedder + deterministic extractor will score low and
   unfairly. Set `CONTEXT_EMBEDDINGS=real`, and - to compare against systems that build memory
   with an LLM (Zep, Mem0) - set `CONTEXT_LLM_URL` so Chitta uses the LLM extractor at ingest too.
   `chitta bench` builds exactly what the MCP server builds, cross-encoder reranker included (on
   by default; `--no-rerank` to measure without it). If the reranker can't load, the run fails
   rather than silently benchmarking a pipeline without it.
2. **Same answer LLM everywhere.** When comparing systems, use the *identical* answer + judge model;
   otherwise you're benchmarking the LLM, not the memory.
3. **Report the config.** Every scorecard header carries `embedder / k / model` - a benchmark
   number without its config is not reproducible or comparable. The `--report` markdown includes it.
4. **Prefer LongMemEval** as the primary (LoCoMo has documented label noise); report LoCoMo for
   comparability with published Mem0/Zep numbers.

## Architecture

```
src/eval/
  metrics.ts                 recall@k / nDCG@k / MRR / P@k  (pure)
  datasets/
    types.ts                 normalized schema every dataset maps onto
    synthetic.ts             built-in offline dataset (all 5 categories)
    longmemeval.ts / locomo.ts   loaders → normalized schema
  bench/
    types.ts                 RunConfig, Scorecard, injectable BenchLlm
    ingest.ts                ingest a case's history into a fresh memory
    retrieval.ts             Tier A - retrieval scoring (reuses metrics.ts)
    qa.ts / llm.ts           Tier B - LLM answer + LLM-as-judge (grounded, abstention-aware)
    pooled.ts                pooled LongMemEval: one store, Chitta vs BM25/dense/RRF, the gate
    pooled-qa.ts             end-to-end answers on the pooled store (plain context or the reader)
    per-question.ts          the official shape: a store per question, sharded, resumable
    scorecard.ts             aggregate per-category + render (console / markdown / json)
    run.ts                   orchestrator (Tier B injected, so Tier A needs no LLM)
```

Add a dataset by implementing `DatasetLoader` (`src/eval/datasets/types.ts`) - the runner is
dataset-agnostic.
