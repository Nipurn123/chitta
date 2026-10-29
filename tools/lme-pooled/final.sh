#!/usr/bin/env bash
# Final Phase 0/1 measurement (whole-day recency): pooled LongMemEval with the reranker on/off and
# the graph leg off (copies of ~/bench/pooled.db), and LoCoMo the same three ways. All in parallel -
# accuracy is deterministic; the shipped default's latency comes from a separate solo run.
set -uo pipefail
B=~/.bun/bin/bun
rm -f ~/bench/final.done
P="src/embedded/cli.ts bench longmemeval --pooled --path $HOME/bench/longmemeval_oracle.json --reuse"
L="src/embedded/cli.ts bench locomo --path $HOME/data/locomo/locomo10.json --tier a --k 10"
for n in rr norr nograph; do
  for s in "" -wal; do [ -f ~/bench/pooled.db$s ] && cp ~/bench/pooled.db$s ~/bench/fin-$n.db$s; done
done
cd ~/context-mcp
$B run $P --store ~/bench/fin-rr.db --out ~/bench/fin-rr.jsonl > ~/bench/fin-rr.log 2>&1 &
$B run $P --store ~/bench/fin-norr.db --no-rerank --out ~/bench/fin-norr.jsonl > ~/bench/fin-norr.log 2>&1 &
CONTEXT_GRAPH=0 $B run $P --store ~/bench/fin-nograph.db --out ~/bench/fin-nograph.jsonl > ~/bench/fin-nograph.log 2>&1 &
$B run $L > ~/bench/fin-locomo-rr.log 2>&1 &
$B run $L --no-rerank > ~/bench/fin-locomo-norr.log 2>&1 &
CONTEXT_GRAPH=0 $B run $L > ~/bench/fin-locomo-nograph.log 2>&1 &
wait
echo DONE > ~/bench/final.done
