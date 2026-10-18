#!/usr/bin/env bash
# Compare cambiatus.cm `mbrclaim` with Postgres member_action_claims, one account at a time.
# Usage: scripts/compare-claim-mirror.sh <chain_url> <pgdatabase> <account>...
# Exit 0 = identical for every account.
set -uo pipefail
CHAIN=$1; DB=$2; shift 2
fail=0
for acc in "$@"; do
  chain=$(curl -s -X POST "$CHAIN/v1/chain/get_table_rows" \
    -d "{\"code\":\"cambiatus.cm\",\"scope\":\"$acc\",\"table\":\"mbrclaim\",\"json\":true,\"limit\":1000}" \
    | jq -c '[.rows[] | {action_id: (.action_id|tonumber), pending, approved, last_rejected_at}] | sort_by(.action_id)')
  db=$(psql -X -At -d "$DB" -c "select coalesce(json_agg(json_build_object('action_id', action_id, 'pending', pending, 'approved', approved, 'last_rejected_at', coalesce(extract(epoch from last_rejected_at)::bigint, 0)) order by action_id), '[]') from member_action_claims where account = '$acc'" | jq -c '.')
  if [ "$chain" = "$db" ]; then echo "OK   $acc"; else echo "DIFF $acc"; echo "  chain: $chain"; echo "  db:    $db"; fail=1; fi
done
exit $fail
