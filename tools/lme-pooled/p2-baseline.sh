#!/usr/bin/env bash
# Re-baseline a build on this machine: pooled LongMemEval with the reranker (alone, for latency),
# then pooled without it and LoCoMo both ways in parallel. Every run works on a copy of the store.
# usage: p2-baseline.sh <code-dir> <tag> <store.db>
set -uo pipefail
CODE=$1 TAG=$2 STORE=$3
B=~/.bun/bin/bun
OUT=~/bench/$TAG
mkdir -p "$OUT" && rm -f "$OUT/done"
cp_store() { for s in "" -wal; do if [ -f "$STORE$s" ]; then cp "$STORE$s" "$OUT/$1.db$s"; fi; done; }
P="src/embedded/cli.ts bench longmemeval --pooled --path $HOME/bench/longmemeval_oracle.json --reuse"
L="src/embedded/cli.ts bench locomo --path $HOME/data/locomo/locomo10.json --tier a --k 10"
cd "$CODE"
cp_store rr && $B run $P --store "$OUT/rr.db" --out "$OUT/rr.jsonl" > "$OUT/rr.log" 2>&1
cp_store norr
$B run $P --store "$OUT/norr.db" --no-rerank --out "$OUT/norr.jsonl" > "$OUT/norr.log" 2>&1 &
$B run $L > "$OUT/locomo-rr.log" 2>&1 &
$B run $L --no-rerank > "$OUT/locomo-norr.log" 2>&1 &
wait
rm -f "$OUT"/*.db "$OUT"/*.db-wal "$OUT"/*.db-shm
echo DONE > "$OUT/done"
