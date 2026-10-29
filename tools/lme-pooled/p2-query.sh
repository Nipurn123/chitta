#!/usr/bin/env bash
# Query-side experiments on copies of an existing pooled store, in parallel (accuracy is
# deterministic). Each arg is "<tag>[:ENV=val,ENV=val]"; e.g. all off:CONTEXT_TIME=0
# usage: p2-query.sh <store.db> <outdir> <tag[:envs]>...
set -uo pipefail
STORE=$1 OUT=$2
shift 2
B=~/.bun/bin/bun
mkdir -p "$OUT" && rm -f "$OUT/done"
P="src/embedded/cli.ts bench longmemeval --pooled --path $HOME/bench/longmemeval_oracle.json --reuse"
cd ~/context-mcp
for spec in "$@"; do
  tag=${spec%%:*}
  envs=""
  [ "$spec" != "$tag" ] && envs=${spec#*:}
  for s in "" -wal; do if [ -f "$STORE$s" ]; then cp "$STORE$s" "$OUT/$tag.db$s"; fi; done
  env ${envs//,/ } $B run $P --store "$OUT/$tag.db" --out "$OUT/$tag.jsonl" > "$OUT/$tag.log" 2>&1 &
done
wait
rm -f "$OUT"/*.db "$OUT"/*.db-wal "$OUT"/*.db-shm
echo DONE > "$OUT/done"
