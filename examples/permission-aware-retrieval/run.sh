#!/usr/bin/env bash
# Permission-aware retrieval - a complete, runnable demo.
#
# Two users in one org, three documents with three different sharing scopes,
# one shared knowledge graph. Each user queries the SAME store and sees ONLY
# what their permissions allow. No servers - one SQLite file.
#
#   bun install && ./examples/permission-aware-retrieval/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

DB="$(mktemp -d)/acme.db"
ctx() { CONTEXT_DB="$DB" bun run src/embedded/cli.ts "$@"; }

echo "── Org + two users ───────────────────────────────────────────"
ctx user-add alice --org acme --email alice@acme.com
ctx user-add bob   --org acme --email bob@acme.com

echo
echo "── Ingest 3 docs, 3 sharing scopes ───────────────────────────"
ctx ingest --id handbook --org acme --name "Company Handbook" --share-org \
  --text "Acme builds privacy-first AI infrastructure. All employees get unlimited PTO and remote work."
ctx ingest --id roadmap  --org acme --name "Eng Roadmap" --share-user alice \
  --text "Q3 roadmap: ship the permission-aware retrieval engine. Alice leads the ACL graph rewrite. Target GA is September."
ctx ingest --id salaries --org acme --name "Comp Bands" --share-user bob \
  --text "Compensation bands for 2026. Senior engineers: 180-220k base. Staff: 230-280k."

echo
echo "── Same query, two users, different results ──────────────────"
echo "ALICE (org handbook + her roadmap; NOT comp):"
ctx query "engineering roadmap" --user alice --org acme
echo
echo "BOB (org handbook + his comp; NOT roadmap):"
ctx query "engineering roadmap" --user bob --org acme

echo
echo "── Shared knowledge graph across all 3 records ───────────────"
ctx rebuild-graph

rm -rf "$(dirname "$DB")"
