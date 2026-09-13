#!/usr/bin/env bash
# Builds a throwaway database from supabase/tests/stub-auth.sql plus every migration, then runs the
# SQL checks in supabase/tests. Needs only a plain Postgres 17; no Docker or Supabase CLI.
#
#   PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres scripts/test-db.sh
set -euo pipefail

cd "$(dirname "$0")/.."
DB="${NEXOVA_TEST_DB:-nexova_test}"
PSQL=(psql -v ON_ERROR_STOP=1 -X -q)

"${PSQL[@]}" -d postgres -c "drop database if exists ${DB}" -c "create database ${DB}"

"${PSQL[@]}" -d "$DB" -f supabase/tests/stub-auth.sql
for migration in supabase/migrations/*.sql; do
  echo "migrate  ${migration}"
  "${PSQL[@]}" -d "$DB" -f "$migration"
done

for test in supabase/tests/*.sql; do
  [[ "$test" == */stub-auth.sql ]] && continue
  echo "test     ${test}"
  "${PSQL[@]}" -d "$DB" -f "$test"
done
