#!/usr/bin/env bash
# Runs each Chitta configuration on its own fresh copy of the ingested store, in parallel.
set -uo pipefail
cd "$(dirname "$0")"
B=~/.bun/bin/bun
rm -f ablate.done
run() { # label, then env assignments
  local label=$1; shift
  for s in "" -wal; do [ -f "lme.db$s" ] && cp "lme.db$s" "ab-$label.db$s"; done
  env LABEL="$label" "$@" $B run lme-ablate.ts "ab-$label.db" "ab-$label.jsonl" > "ab-$label.log" 2>&1
}
NOFIX="CONTEXT_DECAY=0 CONTEXT_RRF_RATIO=0 CONTEXT_MAX_PER_RECORD=1 CONTEXT_RETRIEVE_LIMIT=400"
run chitta+rerank RERANK=1 &
run no-salience CONTEXT_DECAY=0 &
run no-salience+no-cutoff CONTEXT_DECAY=0 CONTEXT_RRF_RATIO=0 &
run no-salience+10-sessions CONTEXT_DECAY=0 FETCH=40 &
run all-fixes $NOFIX &
run all-fixes+rerank $NOFIX RERANK=1 CONTEXT_RERANK_K=50 &
run all-fixes+rerank-blend $NOFIX RERANK=1 CONTEXT_RERANK_K=50 CONTEXT_RERANK_BLEND=1 &
wait
ls ab-*.jsonl | xargs $B run lme-score.ts base.jsonl chitta.jsonl > ablate-score.txt 2>&1
echo DONE > ablate.done
