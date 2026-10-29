#!/usr/bin/env bash
# Repair an official-set run whose model calls failed: back up its rows, re-grade every answered
# row the same way (tools/lme-pooled/rejudge.ts - empty answers and missing verdicts are dropped),
# then resume, so only the dropped questions are answered again with the same code.
# usage: p3-repair.sh <tag> <new-tag> <shards> <reader-model>     (shards must match the original run)
set -uo pipefail
TAG=$1 NEW=$2 N=$3 READER=$4
S=~/bench/s
mkdir -p "$S/$TAG-raw" && cp "$S/$TAG"/rows-*.jsonl "$S/$TAG-raw/"
cd ~/context-mcp
export CONTEXT_LLM_URL=http://127.0.0.1:8790 CONTEXT_LLM_MODEL=google/gemini-3.8-flash CONTEXT_LLM_MAX_TOKENS=8192
files=$(ls "$S/$TAG-raw"/rows-*.jsonl | paste -sd, -)
~/.bun/bin/bun run tools/lme-pooled/rejudge.ts ~/data/lme/longmemeval_s_cleaned.json "$files" "$S/$NEW" > "$S/$NEW-rejudge.log" 2>&1
THREADS=3 ~/bench/p3-s.sh "$NEW" "$N" "$READER"
