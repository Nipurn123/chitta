#!/usr/bin/env bash
# One experiment on a FRESH pooled store built by the current ~/context-mcp code: ingest + query
# with the reranker, then (on a copy) without it, then LoCoMo both ways. Extra args are env
# assignments applied to every run, e.g.  p2-fresh.sh cls CONTEXT_EMBED_POOLING=cls
set -uo pipefail
TAG=$1
shift
B=~/.bun/bin/bun
OUT=~/bench/$TAG
mkdir -p "$OUT" && rm -f "$OUT/done" "$OUT"/*.db*
P="src/embedded/cli.ts bench longmemeval --pooled --path $HOME/bench/longmemeval_oracle.json"
L="src/embedded/cli.ts bench locomo --path $HOME/data/locomo/locomo10.json --tier a --k 10"
cd ~/context-mcp
env "$@" $B run $P --store "$OUT/store.db" --out "$OUT/rr.jsonl" > "$OUT/rr.log" 2>&1
for s in "" -wal; do if [ -f "$OUT/store.db$s" ]; then cp "$OUT/store.db$s" "$OUT/norr.db$s"; fi; done
env "$@" $B run $P --reuse --store "$OUT/norr.db" --no-rerank --out "$OUT/norr.jsonl" > "$OUT/norr.log" 2>&1 &
# LoCoMo is ~5.9k single-turn records; in LLM mode that is ~12k model calls, so SKIP_LOCOMO=1 skips it
if [ "${SKIP_LOCOMO:-0}" != "1" ]; then
  env "$@" $B run $L > "$OUT/locomo-rr.log" 2>&1 &
  env "$@" $B run $L --no-rerank > "$OUT/locomo-norr.log" 2>&1 &
fi
wait
rm -f "$OUT"/norr.db*
echo DONE > "$OUT/done"
