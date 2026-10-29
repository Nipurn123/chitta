#!/usr/bin/env bash
# Official-shape LongMemEval (longmemeval_s): N shard processes, one store per question saved under
# ~/bench/s/stores (reused by later runs), Chitta's memory reader, per-type rules judge. Then merge.
# usage: p3-s.sh <tag> <shards> <reader-model>
set -uo pipefail
TAG=$1 N=$2 READER=$3
DATA=${DATA:-$HOME/data/lme/longmemeval_s_cleaned.json} # a subset file works too (stores are keyed by question id)
B=~/.bun/bin/bun
OUT=~/bench/s/$TAG
mkdir -p "$OUT" ~/bench/s/stores && rm -f "$OUT/done"
export CONTEXT_LLM_URL=http://127.0.0.1:8790 CONTEXT_LLM_MODEL=google/gemini-3.8-flash CONTEXT_LLM_MAX_TOKENS=8192 CONTEXT_LLM_LOG_EVERY=0 CONTEXT_EMBED_THREADS=${THREADS:-2}
cd ~/context-mcp
for i in $(seq 0 $((N - 1))); do
  $B run src/embedded/cli.ts bench longmemeval --per-question --path "$DATA" \
    --shard $i/$N --out "$OUT/rows-$i.jsonl" --store-dir ~/bench/s/stores --reader-model "$READER" ${INGEST_ONLY:+--ingest-only} > "$OUT/shard-$i.log" 2>&1 &
done
wait
files=$(ls "$OUT"/rows-*.jsonl | paste -sd, -)
$B run src/embedded/cli.ts bench longmemeval --merge "$files" > "$OUT/result.txt" 2>&1
echo DONE > "$OUT/done"
