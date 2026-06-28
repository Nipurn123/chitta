# Token-Reduction Benchmark - How to Reproduce

This is the corpus and harness behind the **7.4× token-reduction** number (and the
**zero cross-user leak** result). Everything here is committed and reproducible - the
report in [BENCHMARK.md](BENCHMARK.md) is generated from the live run, not hand-written.

## What it measures

To answer a question, the naive approach stuffs the **entire knowledge base** into the
model's context. Chitta retrieves only the **top-k permitted snippets**. The
benchmark reports, from the *actual* retrieved content:

- reduction vs the **full corpus**, and
- reduction vs each user's **permitted subset** (the fair, conservative baseline), and
- an **ACL leak check** - the same query asked by a permitted and a non-permitted user.

## Corpus (8 documents)

A small company knowledge base in [`raw/`](raw/), permission-scoped:

```
raw/
├── handbook.md                     (org-wide)
├── security-policy.md              (org-wide)
├── oncall-runbook.md               (eng only)
├── architecture-overview.md        (eng only)
├── api-guide.md                    (eng only)
├── incident-2026-03-postmortem.md  (eng only)
├── compensation-bands.md           (hr only)
└── hiring-process.md               (hr only)
```

Two users: `alice` (engineering) and `bob` (HR). Each sees only their permitted subset.

## Run it

```bash
bun install
bun run examples/token-reduction/benchmark.ts
```

This ingests `raw/`, runs eight real queries as the two users, prints the results, and
rewrites [BENCHMARK.md](BENCHMARK.md).

## What to expect

- **~7× fewer tokens** than dumping the whole knowledge base; **~5×** versus dumping only
  each user's permitted subset. The factor **grows with corpus size** - retrieved size
  stays roughly constant while the dump grows with every document you add.
- **No cross-user leak:** ask *"what are the compensation bands?"* as `bob` (HR) and the
  Compensation doc is in the results; ask the same as `alice` (eng) and it is **never**
  there - even though she still gets snippets from her own permitted docs.

## A note on ranking

This run uses the dependency-free **hashing embedder**, so *which* snippets are returned
is not yet semantically ranked. The **token-reduction and ACL guarantees are structural**
and hold regardless of the embedder; semantic ranking improves when you swap in real
embeddings (see the [README](../../README.md#status) "Status → Next"). Full numbers and
methodology: [BENCHMARK.md](BENCHMARK.md).
