#!/usr/bin/env bash
# Importance out of the ranking (CONTEXT_IMPORTANCE_W default 0): pooled LongMemEval with the
# reranker on/off (copies of ~/bench/pooled.db) and LoCoMo the same two ways.
set -uo pipefail
B=~/.bun/bin/bun
rm -f ~/bench/w0.done
P="src/embedded/cli.ts bench longmemeval --pooled --path $HOME/bench/longmemeval_oracle.json --reuse"
L="src/embedded/cli.ts bench locomo --path $HOME/data/locomo/locomo10.json --tier a --k 10"
for n in rr norr; do
  for s in "" -wal; do [ -f ~/bench/pooled.db$s ] && cp ~/bench/pooled.db$s ~/bench/w0-$n.db$s; done
done
cd ~/context-mcp
$B run $P --store ~/bench/w0-rr.db --out ~/bench/w0-rr.jsonl > ~/bench/w0-rr.log 2>&1 &
$B run $P --store ~/bench/w0-norr.db --no-rerank --out ~/bench/w0-norr.jsonl > ~/bench/w0-norr.log 2>&1 &
$B run $L > ~/bench/w0-locomo-rr.log 2>&1 &
$B run $L --no-rerank > ~/bench/w0-locomo-norr.log 2>&1 &
wait
echo DONE > ~/bench/w0.done
