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
  bun run src/embedded/cli.ts bench locomo --path locomo10.json --tier a --k 10 --rerank

# any OpenAI-compatible endpoint also works (a full /chat/completions URL is used verbatim);
# thinking models need CONTEXT_LLM_MAX_TOKENS >= ~1500 or the answer comes back empty.
```

Report **both** numbers - the zero-token default (what ships) and the with-LLM mode (the
head-to-head) - so the comparison is honest: accuracy *at token cost*. The LLM extraction is
thousands of calls for a full run, so start with `--limit 1` to sanity-check before a full sweep.

## Fairness (so the number means something)

1. **Turn on the real pipeline.** The hash embedder + deterministic extractor will score low and
   unfairly. Set `CONTEXT_EMBEDDINGS=real`, and - to compare against systems that build memory
   with an LLM (Zep, Mem0) - set `CONTEXT_LLM_URL` so Chitta uses the LLM extractor at ingest too.
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
    scorecard.ts             aggregate per-category + render (console / markdown / json)
    run.ts                   orchestrator (Tier B injected, so Tier A needs no LLM)
```

Add a dataset by implementing `DatasetLoader` (`src/eval/datasets/types.ts`) - the runner is
dataset-agnostic.
