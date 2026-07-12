#!/usr/bin/env bash
# Cross-session agent memory — the "aha": your agent REMEMBERS across sessions.
#
# This runs SESSION 1 and SESSION 2 as TWO SEPARATE bun processes that share one
# SQLite file. Process B never sees process A run — it just opens the file and
# recalls what A learned. That's the whole point: memory that outlives the process.
#
#   ./examples/agent-memory/run.sh
set -euo pipefail
cd "$(dirname "$0")"

DB="./agent-memory.db"
cleanup() { rm -f "$DB" "$DB-wal" "$DB-shm"; }
trap cleanup EXIT
cleanup # start clean

CHITTA_DEMO_DB="$DB" bun run demo.ts session1

echo
echo "   ……… process A exited. launching a brand-new process B (same file) ………"

CHITTA_DEMO_DB="$DB" bun run demo.ts session2
