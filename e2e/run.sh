#!/usr/bin/env bash
# End-to-end test: installs gina from a packed tarball into a separate project (e2e/fixture),
# then generates and applies migrations against a fresh MySQL schema, exactly like a user would.
#
# Needs a MySQL server. Connection comes from DB_HOST, DB_PORT, DB_USERNAME and DB_PASSWORD.
# Set UPDATE_SNAPSHOTS=1 to rewrite e2e/expected/*.json instead of comparing against them.
set -euo pipefail

E2E_DIR="$(cd "$(dirname "$0")" && pwd)"
GINA_DIR="$(dirname "$E2E_DIR")"
WORK_DIR="$(mktemp -d)"
PROJECT_DIR="$WORK_DIR/project"

export DB_HOST="${DB_HOST:-127.0.0.1}"
export DB_PORT="${DB_PORT:-3306}"
export DB_USERNAME="${DB_USERNAME:-root}"
export DB_PASSWORD="${DB_PASSWORD:-root}"
export DB_NAME="gina_e2e_$(date +%s)_$RANDOM"

step() { echo; echo "==> $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
db() { node "$E2E_DIR/db.js" "$@"; }

cleanup() {
    db drop >/dev/null 2>&1 || true
    rm -rf "$WORK_DIR"
}
trap cleanup EXIT

migration_count() { find "$PROJECT_DIR/gina/migrations" -name '*.ts' | wc -l | tr -d ' '; }
migrations() { find "$PROJECT_DIR/gina/migrations" -name '*.ts' -exec basename {} .ts \; | sort; }
last_migration() { migrations | tail -1; }
nth_migration() { migrations | sed -n "$1p"; }

assert_migration_count() {
    [ "$(migration_count)" = "$1" ] || fail "expected $1 migration files, found $(migration_count)"
}

assert_version() {
    local version expected="${1:-$(last_migration)}"
    version="$(db version)"
    [ "$version" = "$expected" ] || fail "gina_version is '$version', expected '$expected'"
}

assert_schema() {
    local expected="$E2E_DIR/expected/$1.json"
    db dump > "$WORK_DIR/$1.json"
    if [ "${UPDATE_SNAPSHOTS:-}" = "1" ]; then
        mkdir -p "$E2E_DIR/expected"
        cp "$WORK_DIR/$1.json" "$expected"
        echo "snapshot written: $expected"
    else
        diff -u "$expected" "$WORK_DIR/$1.json" || fail "schema differs from $expected"
        echo "schema matches expected/$1.json"
    fi
}

step "node $(node -v), database $DB_NAME"

step "packing gina"
(cd "$GINA_DIR" && npm run build --silent && npm pack --silent --pack-destination "$WORK_DIR" >/dev/null)

step "creating external project"
cp -R "$E2E_DIR/fixture" "$PROJECT_DIR"
cd "$PROJECT_DIR"
npm install --no-audit --no-fund --loglevel=error "$WORK_DIR"/gina-sequelize-*.tgz
db create

step "gina-cli init"
npx gina-cli init
assert_migration_count 1

step "upgrade on an empty database"
npx gina-cli upgrade
assert_version

step "generate-migration with the initial models"
sleep 1
npx gina-cli generate-migration "initial structure"
assert_migration_count 2

step "upgrade (npm script)"
npm run --silent db:upgrade
assert_version
assert_schema v1

step "generate-migration without changes must not create a file"
npx gina-cli generate-migration "nothing changed"
assert_migration_count 2

step "changing the models"
cp -R "$E2E_DIR/changes/." "$PROJECT_DIR/"
sleep 1
npm run --silent db:migration -- "second version"
assert_migration_count 3
cat "$PROJECT_DIR"/gina/migrations/*-second-version.ts

step "upgrade with the new migration"
npm run --silent db:upgrade
assert_version
assert_schema v2

step "downgrade reverts the last migration"
npx gina-cli downgrade
assert_version "$(nth_migration 2)"
assert_schema v1

step "downgrade 2 from v2 goes back to the version table only"
npm run --silent db:upgrade
npx gina-cli downgrade 2
assert_version "$(nth_migration 1)"
assert_schema base

step "downgrade can't revert the first migration, and changes nothing when refused"
npm run --silent db:upgrade
if npx gina-cli downgrade 3; then
    fail "downgrade 3 should have failed"
fi
assert_version
assert_schema v2

step "downgrade --to a migration (by timestamp prefix) keeps it applied"
npx gina-cli downgrade --to "$(nth_migration 2 | cut -d- -f1)"
assert_version "$(nth_migration 2)"
assert_schema v1
npm run --silent db:upgrade
assert_version
assert_schema v2

step "generate-migration after the upgrade must not create a file"
npx gina-cli generate-migration "nothing changed"
assert_migration_count 3

step "upgrade again is a no-op"
npm run --silent db:upgrade
assert_version

step "production-like run: compiled .js only, no TypeScript sources"
npx tsc --outDir "$WORK_DIR/dist"
cp package.json "$WORK_DIR/dist/"
ln -s "$PROJECT_DIR/node_modules" "$WORK_DIR/dist/node_modules"
if find "$WORK_DIR/dist" -path "$WORK_DIR/dist/node_modules" -prune -o -name '*.ts' -print | grep -q .; then
    fail "compiled output should not contain .ts files"
fi
db create
(cd "$WORK_DIR/dist" && npm run --silent db:upgrade)
assert_version
assert_schema v2

step "e2e passed on node $(node -v)"
