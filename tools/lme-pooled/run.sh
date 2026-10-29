#!/usr/bin/env bash
# Full pooled LongMemEval run on the VM: ingest all 940 sessions once, then each query mode on
# its own copy of the store (retrieval bumps access counts), one at a time so latencies are clean.
set -euo pipefail
cd "$(dirname "$0")"
B=~/.bun/bin/bun
rm -f done.flag failed.flag
trap 'echo FAILED > failed.flag' ERR

$B run lme-ingest.ts lme.db > ingest.log 2>&1
$B run check-emb.ts lme.db >> ingest.log

for m in baselines chitta chitta-ppr; do
  for s in "" -wal; do [ -f "lme.db$s" ] && cp "lme.db$s" "$m.db$s"; done
done
$B run lme-query.ts baselines.db baselines base.jsonl > q-baselines.log 2>&1
$B run lme-query.ts chitta.db chitta chitta.jsonl > q-chitta.log 2>&1
$B run lme-query.ts chitta-ppr.db chitta-ppr ppr.jsonl > q-ppr.log 2>&1

$B run lme-score.ts base.jsonl chitta.jsonl ppr.jsonl > score.txt
$B run lme-diff.ts chitta bm25+dense-rrf base.jsonl chitta.jsonl > diff-chitta-vs-rrf.txt
$B run lme-diff.ts chitta bm25 base.jsonl chitta.jsonl > diff-chitta-vs-bm25.txt
$B run lme-diff.ts chitta-ppr chitta chitta.jsonl ppr.jsonl > diff-ppr-vs-chitta.txt
echo DONE > done.flag
