# Why Chitta scales

Chitta's job is to stay **fast and correct** as the corpus grows and as more users share one store. This doc shows **why**, with **measured** numbers rather than claims.

> **About these numbers.** Everything here was measured **this session, on a dev laptop**, with the **hash embedder** unless noted (so retrieval quality is held constant and we're measuring the *engine*, not the model). They're honest single-machine figures - read them as **shapes and ratios**, not datacenter SLAs. Your absolute milliseconds will differ; the **scaling behavior** is the point. End-to-end memory *quality* is a separate axis - see [BENCHMARKING.md](BENCHMARKING.md).

## Graph retrieval - O(1) in graph size

The graph hop that expands results along `relates_to` edges is **bounded**, so its cost doesn't grow with the graph. Latency stays **flat** where an unbounded hop degrades as the corpus fills.

| Corpus | Bounded hop (default) | Unbounded hop |
|---|---|---|
| 50K records | ~0.05 ms | (growing) |
| 100K records | **~0.05 ms** (flat) | **~2 ms** and climbing |

At 100K the bounded hop is **≈39× faster** - and **recall didn't suffer**: it was **+0.6%** vs the unbounded hop on LoCoMo Tier-A. Bounding the traversal made it both faster *and* slightly more accurate (less off-topic expansion).

**Takeaway:** graph expansion is effectively **O(1) in graph size** - flat at ~0.05 ms from 50K→100K, with recall held. On by default; toggle with `CONTEXT_GRAPH_BOUNDED`.

## Ingest - from O(N²) toward ~O(N log N)

Ingest used to get **more expensive per record** as the store filled up, because belief-revision and ACL checks re-scanned the whole corpus on every write - quadratic overall. Making those checks **change-proportional** - driven by the record being written, not the whole corpus - flattened the curve.

| Per-record ingest | 1K | 8K | 16K | 20K |
|---|---|---|---|---|
| **Before** (O(N²)) | 2.25 ms | 25.7 ms | - | timed out |
| **After** (~O(N log N)) | 0.60 ms | - | 1.72 ms | - |

**Takeaway:** **16× more data for ~2.9× the per-record cost** (0.60 → 1.72 ms across 1K→16K) - strongly sublinear, where the old path grew quadratically and timed out by 20K.

## Filtered-ANN - ACL-first dense search

When a user's accessible set is **selective** (≤ `CONTEXT_FILTER_FIRST_MAX`, default **2000**), the dense stage scans **exactly the accessible vectors** - via a `virtual_record_id` index - instead of the whole corpus. It's **O(accessible), not O(corpus)**, and because inaccessible rows are **never candidates**, it's **leak-proof by construction** and still **exact**.

| Metric | Result |
|---|---|
| LoCoMo recall - filtered-ANN **on vs off** | **identical (Δ = 0)** |
| Scoped-user query latency @ 12K corpus | **~4.6× faster** (gap widens with corpus) |
| Correctness | **exact** + **leak-proof by construction** |

**Takeaway:** for scoped / multi-tenant users this makes dense retrieval scale with **their slice**, not the org - for free (Δ = 0 recall), and the win **grows** as the shared store grows. No flag needed; it engages automatically below the threshold.

## Plaintext DiskANN (opt-in) - `CONTEXT_DISKANN=1`

Chitta can run libSQL's **native DiskANN** ANN index **in plaintext** - no encryption required. Against the default `vec0` (sqlite-vec) index, raw ANN query latency vs corpus size:

| Vectors | `vec0` (default) | DiskANN (`CONTEXT_DISKANN=1`) |
|---|---|---|
| 3K | 1.58 ms | 8.43 ms |
| 9K | 4.76 ms | 6.90 ms |
| 18K | 9.68 ms | 8.14 ms |
| 100K | **51 ms** | **~8 ms** (~6×) |

`vec0` grows **linearly** (O(N)); DiskANN is **flat**. Recall is standard-ANN approximate: **0.98 top-10 overlap** with exact search.

**Honest tradeoff - this is not a default:**

| | `vec0` (default) | DiskANN |
|---|---|---|
| Query latency | O(N), no fixed floor | **flat, ~8 ms constant floor** |
| Per-vector ingest | ~0.08 ms | **~7 ms (~80× slower)** |
| Best for | small-mid, or write-heavy | **large, read-heavy, static** |

Because of that ~8 ms query floor, **`vec0` is faster below the ~15-18K crossover**; DiskANN only pays off above it. And the **~80× ingest penalty** means it's for corpora you write **rarely** and read **often**. Enable it deliberately, never by default.

## What's still O(N) (the honest note)

Not everything is sub-linear, and we won't pretend it is. **Keyword / FTS matching on a non-selective query term** is **O(matches)** - if a term hits a large fraction of the corpus, the keyword stage has to walk that many postings. This is **query- and data-dependent, not a fundamental scaling wall**: selective queries stay cheap, the vector and graph stages above are already sub-linear, and the cost is bounded by how common your query terms are. Worth knowing when you profile a specific workload.

---

See also: [DEPLOYMENT.md](DEPLOYMENT.md) · [ARCHITECTURE.md](../ARCHITECTURE.md) · [BENCHMARKING.md](BENCHMARKING.md) · [SDK.md](SDK.md)
