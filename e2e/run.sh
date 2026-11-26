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

MIGRATIONS_DIR="$PROJECT_DIR/gina/migrations"
head_file() { cat "$MIGRATIONS_DIR/HEAD"; }

# expect_failure <pattern> <command...>: the command must fail and print <pattern>
expect_failure() {
    local pattern="$1" output
    shift
    if output="$("$@" 2>&1)"; then
        echo "$output"
        fail "'$*' should have failed"
    fi
    echo "$output" | grep -q -- "$pattern" || { echo "$output"; fail "'$*' failed without '$pattern'"; }
    echo "failed as expected: $pattern"
}

# add_scenario <scenario> <migration name> <previous>: copies e2e/scenarios/<scenario>.ts into the project
add_scenario() {
    sed "s/PREVIOUS/$3/" "$E2E_DIR/scenarios/$1.ts" > "$MIGRATIONS_DIR/$2.ts"
}

assert_table() {
    db tables | grep -qx "$1" || fail "table $1 should exist"
}

assert_no_temporary_databases() {
    [ -z "$(db temporary-databases)" ] || fail "temporary databases were left behind: $(db temporary-databases)"
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

step "an attribute-level unique index is matched by its columns, whatever its name"
node "$E2E_DIR/db.js" query "ALTER TABLE posts RENAME INDEX posts_slug_unique TO posts_slug_custom_name"
npx gina-cli generate-migration "nothing changed"
assert_migration_count 3
node "$E2E_DIR/db.js" query "ALTER TABLE posts RENAME INDEX posts_slug_custom_name TO posts_slug_unique"

step "generated migrations are tidy: no blank lines after { or before }, no double blank lines, newline at the end"
for file in "$MIGRATIONS_DIR"/*.ts; do
    node -e '
        const code = require("fs").readFileSync(process.argv[1], "utf8");
        const untidy = /\{\n[ \t]*\n|\n[ \t]*\n[ \t]*\}|\n[ \t]*\n[ \t]*\n/.test(code) || !code.endsWith("\n");
        process.exit(untidy ? 1 : 0);
    ' "$file" || fail "$(basename "$file") is not tidy"
done

step "upgrade again is a no-op"
npm run --silent db:upgrade
assert_version

step "migrations form a chain: each generated one runs after the previous, HEAD has the last one"
INITIAL="$(nth_migration 2)"
SECOND="$(nth_migration 3)"
grep -q "export const previous = '$(nth_migration 1)'" "$MIGRATIONS_DIR/$INITIAL.ts" || fail "$INITIAL should run after $(nth_migration 1)"
grep -q "export const previous = '$INITIAL'" "$MIGRATIONS_DIR/$SECOND.ts" || fail "$SECOND should run after $INITIAL"
[ "$(head_file)" = "$SECOND" ] || fail "HEAD should be $SECOND"
npx gina-cli check

step "a branch merged late: two migrations after the same one are refused"
# named to sort before $SECOND, like a branch created before it but merged after it
LATE="${INITIAL%%-*}-late-branch"
add_scenario late-branch "$LATE" "$INITIAL"
expect_failure "all run right after $INITIAL" npx gina-cli check
expect_failure "all run right after $INITIAL" npx gina-cli upgrade
expect_failure "all run right after $INITIAL" npx gina-cli generate-migration "should not be created"
assert_version "$SECOND"

step "after the conflict is resolved, the late migration runs even though its name sorts first"
add_scenario late-branch "$LATE" "$SECOND"
expect_failure "HEAD says the last migration is $SECOND" npx gina-cli check
echo "$LATE" > "$MIGRATIONS_DIR/HEAD"
npx gina-cli check
npx gina-cli upgrade
assert_version "$LATE"
assert_table late_branch
npx gina-cli downgrade
assert_version "$SECOND"
assert_schema v2
rm "$MIGRATIONS_DIR/$LATE.ts"
echo "$SECOND" > "$MIGRATIONS_DIR/HEAD"

step "upgrade --dry-run catches a failing migration without touching the database"
HALFWAY="$(date +%Y%m%d%H%M%S)-fails-halfway"
add_scenario fails-halfway "$HALFWAY" "$SECOND"
echo "$HALFWAY" > "$MIGRATIONS_DIR/HEAD"
expect_failure "dry run failed" npx gina-cli upgrade --dry-run
assert_version "$SECOND"
assert_schema v2
assert_no_temporary_databases

step "a migration that fails halfway is recorded, and upgrade refuses to run until it's repaired"
expect_failure "addColumn users.halfway" npx gina-cli upgrade
expect_failure "repair --continue" npx gina-cli upgrade
expect_failure "repair --continue" npx gina-cli downgrade
assert_version "$SECOND"

step "repair --rollback undoes what was applied"
npx gina-cli repair --rollback | tee "$WORK_DIR/repair.log"
grep -q "skipped: removeIndex users users_halfway" "$WORK_DIR/repair.log" || fail "repair should skip the index that was never created"
assert_version "$SECOND"
assert_schema v2

step "repair --continue finishes the migration after the cause is fixed"
expect_failure "addColumn users.halfway" npx gina-cli upgrade
sed -i.bak "s/missing_column/halfway/" "$MIGRATIONS_DIR/$HALFWAY.ts" && rm "$MIGRATIONS_DIR/$HALFWAY.ts.bak"
npx gina-cli repair --continue | tee "$WORK_DIR/repair.log"
grep -q "skipped: addColumn users.halfway" "$WORK_DIR/repair.log" || fail "repair should skip the column that was already added"
assert_version "$HALFWAY"
npx gina-cli repair --continue | grep -q "Nothing to repair" || fail "repair without a failure should do nothing"
npx gina-cli downgrade
assert_schema v2

step "upgrade --dry-run passes on a valid migration and changes nothing"
npx gina-cli upgrade --dry-run
assert_version "$SECOND"
assert_schema v2
assert_no_temporary_databases
rm "$MIGRATIONS_DIR/$HALFWAY.ts"
echo "$SECOND" > "$MIGRATIONS_DIR/HEAD"

step "snapshot, then upgrade --from-snapshot on an empty database"
npx gina-cli snapshot
grep -q "^-- version: $SECOND$" "$PROJECT_DIR/gina/snapshot.sql" || fail "snapshot should be at $SECOND"
assert_no_temporary_databases
expect_failure "only works on an empty database" npx gina-cli upgrade --from-snapshot
# a migration added after the snapshot was taken still runs
add_scenario late-branch "$LATE" "$SECOND"
echo "$LATE" > "$MIGRATIONS_DIR/HEAD"
db create
npx gina-cli upgrade --from-snapshot | tee "$WORK_DIR/snapshot.log"
grep -q "applying migration: $LATE" "$WORK_DIR/snapshot.log" || fail "the migration after the snapshot should run"
grep -q "applying migration: $INITIAL" "$WORK_DIR/snapshot.log" && fail "migrations in the snapshot should not run"
assert_version "$LATE"
npx gina-cli downgrade
assert_schema v2
npx gina-cli downgrade --to "$INITIAL"
assert_schema v1
rm "$MIGRATIONS_DIR/$LATE.ts" "$PROJECT_DIR/gina/snapshot.sql"
echo "$SECOND" > "$MIGRATIONS_DIR/HEAD"
npm run --silent db:upgrade
assert_schema v2

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
