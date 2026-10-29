#!/usr/bin/env bash
# Final Phase 2 measurement with the current ~/context-mcp code. First, ALONE (clean latency): the
# zero-LLM shipped default on the round-chunk store. Then in parallel: zero-LLM without reranker,
# LoCoMo both ways, and LLM mode (fact keys + query expansion) on the LLM store.
set -uo pipefail
B=~/.bun/bin/bun
OUT=~/bench/final2
mkdir -p "$OUT" && rm -f "$OUT/done"
P="src/embedded/cli.ts bench longmemeval --pooled --path $HOME/bench/longmemeval_oracle.json --reuse"
L="src/embedded/cli.ts bench locomo --path $HOME/data/locomo/locomo10.json --tier a --k 10"
LLM="CONTEXT_LLM_URL=http://127.0.0.1:8790 CONTEXT_LLM_MODEL=google/gemini-3.8-flash CONTEXT_LLM_MAX_TOKENS=4096 CONTEXT_LLM_LOG_EVERY=0"
cp_store() { for s in "" -wal; do if [ -f "$1$s" ]; then cp "$1$s" "$OUT/$2.db$s"; fi; done; }
cd ~/context-mcp
cp_store ~/bench/e2-rounds/store.db zero-rr
$B run $P --store "$OUT/zero-rr.db" --out "$OUT/zero-rr.jsonl" > "$OUT/zero-rr.log" 2>&1
cp_store ~/bench/e2-rounds/store.db zero-norr
cp_store ~/bench/llm2/store.db llm-rr
$B run $P --store "$OUT/zero-norr.db" --no-rerank --out "$OUT/zero-norr.jsonl" > "$OUT/zero-norr.log" 2>&1 &
$B run $L > "$OUT/locomo-rr.log" 2>&1 &
$B run $L --no-rerank > "$OUT/locomo-norr.log" 2>&1 &
env $LLM $B run $P --store "$OUT/llm-rr.db" --out "$OUT/llm-rr.jsonl" > "$OUT/llm-rr.log" 2>&1 &
wait
rm -f "$OUT"/*.db "$OUT"/*.db-wal "$OUT"/*.db-shm
echo DONE > "$OUT/done"
