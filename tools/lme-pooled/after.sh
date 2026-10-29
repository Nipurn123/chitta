#!/usr/bin/env bash
# Follow-up runs after the default `bench longmemeval --pooled` run built ~/bench/pooled.db:
# pooled ablations on copies of that store, plus LoCoMo old-vs-new code (old = git HEAD before the
# Phase 0/1 changes, staged in ~/context-mcp-old with node_modules symlinked). All in parallel:
# accuracy is deterministic, so only the latency columns are affected by sharing the CPU.
set -uo pipefail
B=~/.bun/bin/bun
rm -f ~/bench/after.done
for n in norerank graphoff; do
  for s in "" -wal; do [ -f ~/bench/pooled.db$s ] && cp ~/bench/pooled.db$s ~/bench/pooled-$n.db$s; done
done
P="src/embedded/cli.ts bench longmemeval --pooled --path $HOME/bench/longmemeval_oracle.json --reuse"
L="src/embedded/cli.ts bench locomo --path $HOME/data/locomo/locomo10.json --tier a --k 10"
cd ~/context-mcp
$B run $P --store ~/bench/pooled-norerank.db --no-rerank --out ~/bench/pooled-norerank.jsonl > ~/bench/pooled-norerank.log 2>&1 &
CONTEXT_GRAPH=0 $B run $P --store ~/bench/pooled-graphoff.db --out ~/bench/pooled-graphoff.jsonl > ~/bench/pooled-graphoff.log 2>&1 &
$B run $L > ~/bench/locomo-new-rerank.log 2>&1 &
$B run $L --no-rerank > ~/bench/locomo-new-norerank.log 2>&1 &
(cd ~/context-mcp-old && $B run $L --rerank > ~/bench/locomo-old-rerank.log 2>&1) &
(cd ~/context-mcp-old && $B run $L > ~/bench/locomo-old-norerank.log 2>&1) &
wait
echo DONE > ~/bench/after.done
