# Gina

Gina is a migration tool for [Sequelize](https://sequelize.org/) projects, in the spirit of Python's Alembic:

- **`generate-migration`** compares your Sequelize models with a live database and writes a migration file with the differences.
- **`upgrade`** applies every pending migration, in order, and records the current version in the database.
- **`downgrade`** reverts applied migrations, newest first, running their `down` functions.

Plus some safety nets: migrations form a chain, so a branch merged late can't be skipped silently; `upgrade --dry-run` rehearses pending migrations on a copy of the schema; a migration that fails halfway is recorded and can be finished or undone with `repair`; and `snapshot` lets development databases skip hundreds of migrations.

It's a regular CLI. You install it in your project and run it from the project folder, locally while developing and in production as a deploy step. It works with migrations and models written in TypeScript or in plain/compiled JavaScript, on any Node version from 18 up.

## How it works

When you run `gina-cli`, it:

1. Reads the `gina` section of the `package.json` in the current folder.
2. Connects to the database using the `DB_*` environment variables (and a `.env` file, if there is one).
3. Loads every model file in `modelsDir` and calls the `initializeModel(sequelize)` function each one exports.
4. Loads the migration files in `migrationsDir` and puts them in order (see [Migration order](#migration-order)).
5. Runs the command.

**TypeScript files** are transpiled on the fly with your project's own `typescript` package and `tsconfig.json`. Gina only transpiles them, it doesn't type-check, and it doesn't need `ts-node`, `tsx` or any Node loader flags. That's why it behaves the same on every Node version.

**JavaScript files** are loaded as they are. In production you can ship only the compiled output (`.js`) and run `gina-cli upgrade` there without TypeScript sources.

When the same migration exists as both `.ts` and `.js`, the `.ts` one is used.

### Version control

Gina keeps a single row in a `gina_version` table with the name of the last applied migration, e.g. `20240531183010-adding-initial-structure`. `upgrade` runs every migration that comes after it in the [migration order](#migration-order).

### Migration order

Each generated migration says which migration it runs after:

```ts
export const previous = '20240531183010-adding-initial-structure';
```

So migrations form a chain, and that chain (not the file names) decides the order. Migrations without `previous`, like the ones written before Gina had the chain, come first, sorted by name.

`gina/migrations/HEAD` holds the name of the last migration, and `generate-migration` updates it. Its job is to make git complain: when two branches each add a migration, both change `HEAD`, so the second one to merge has a conflict instead of merging silently. Without the chain, the migration with the older timestamp would sort before the version the database is already at and never run.

To resolve it, make the migration that was merged last run after the other one: set its `previous` to the other branch's last migration, and set `HEAD` to it. If the conflict is resolved without that, Gina notices: two migrations with the same `previous` (a fork) make `upgrade`, `generate-migration` and `check` fail with a message saying what to fix, and so does a `HEAD` that isn't the last migration of the chain.

Run `gina-cli check` in CI to catch this before deploying. It doesn't need a database.

## Installation

Install it as a project dependency, so local, CI and production all run the same version:

```bash
npm install gina-sequelize
```

Your project also needs `sequelize` (a peer dependency), the driver for your database (e.g. `mysql2`) and, if your models or migrations are TypeScript, `typescript`.

Then run it with `npx gina-cli <command>`, or through npm scripts:

```json
{
  "scripts": {
    "db:upgrade": "gina-cli upgrade",
    "db:migration": "gina-cli generate-migration"
  }
}
```

```bash
npm run db:upgrade
npm run db:migration -- "add users table"
```

A global install (`npm install -g gina-sequelize`) also works. When the project has its own copy, the global `gina-cli` hands off to it, so models, migrations and gina all use the same `sequelize`.

## Configuration

### `package.json`

```json
{
  "gina": {
    "modelsDir": "src/database/models",
    "migrationsDir": "gina/migrations",
    "sequelize": {
      "timezone": "-03:00"
    }
  }
}
```

| Option | Default | Description |
| --- | --- | --- |
| `modelsDir` | `gina/models` | Folder with your model files, relative to the project root. |
| `migrationsDir` | `gina/migrations` | Folder with the migration files, relative to the project root. |
| `snapshotFile` | `snapshot.sql` next to `migrationsDir` | Schema snapshot written by `gina-cli snapshot`. |
| `sequelize` | — | Extra options passed to the `Sequelize` constructor. They override the defaults built from the environment variables. |

Use paths that are valid in both your source tree and your build output. For example, if `tsc` compiles `src/database/models/*.ts` to `dist/src/database/models/*.js` and production runs from `dist/`, `src/database/models` works in both places. Remember to ship `package.json` with the build.

### Database connection

| Variable | Default |
| --- | --- |
| `DB_HOST` | — |
| `DB_PORT` | the dialect's default |
| `DB_NAME` | — |
| `DB_USERNAME` | — |
| `DB_PASSWORD` | — |
| `DB_DIALECT` | `mysql` |

If there's a `.env` file in the project folder, Gina loads it. Variables already set in the environment take precedence, which is what you want in production.

### Models

Each file in `modelsDir` must export an `initializeModel(sequelize)` function that initializes the model. It can return a function that sets up associations. Gina calls those only after every model is initialized:

```ts
import { Model, Sequelize, DataTypes } from 'sequelize';
import { Post } from './post';

export class User extends Model {}

export function initializeModel(sequelize: Sequelize) {
    User.init({
        id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
        name: { type: DataTypes.STRING, allowNull: false },
    }, { tableName: 'users', sequelize });

    return () => {
        User.hasMany(Post, { foreignKey: 'userId', as: 'posts' });
    };
}
```

Files that don't export `initializeModel` are skipped with a warning.

#### Custom model loading (`gina/initializeModels`)

If your project needs to build the Sequelize instance itself, create `gina/initializeModels.ts` (or `.js`) exporting an `initializeModels()` function that returns a Sequelize instance with every model already loaded. When this file exists Gina uses it, and ignores `modelsDir` and the `DB_*` variables.

### Migrations

A migration exports `migration` with `up` and `down` functions that receive Sequelize's `QueryInterface`, and `previous`, the migration it runs after:

```ts
import { QueryInterface, DataTypes } from 'sequelize';

export const previous = '20240531183010-adding-initial-structure';

export const migration = {
    async up(queryInterface: QueryInterface) {
        await queryInterface.addColumn('users', 'nickname', { type: DataTypes.STRING, allowNull: true });
    },

    async down(queryInterface: QueryInterface) {
        await queryInterface.removeColumn('users', 'nickname');
    }
};
```

## Commands

### `gina-cli init`

Creates `gina/migrations` with the first migration, which creates the `gina_version` table, and the `HEAD` file. Then set `gina.modelsDir` in your `package.json`.

### `gina-cli upgrade`

Applies every pending migration in order, updating `gina_version` after each one. Run it on deploy, before the new version of the app starts.

#### `--dry-run`

Rehearses the pending migrations without changing the database (MySQL/MariaDB): Gina copies the schema, without data, to a temporary database on the same server, applies the pending migrations there and drops it. Run it in the deploy before the real `upgrade` to catch errors like an index or foreign key that can't be created, a column that doesn't exist, or a name that's already taken.

Errors that depend on the data can still happen, like duplicates on a new unique index or NULLs on a column that becomes `NOT NULL`. The database user needs permission to create and drop databases.

#### `--from-snapshot`

On an empty database, creates the schema from the [snapshot](#gina-cli-snapshot) and then applies only the migrations after it. Meant for development, where recreating the database would otherwise run every migration.

### When a migration fails halfway

MySQL can't roll back schema changes: every `CREATE TABLE`, `ALTER TABLE` or `CREATE INDEX` is committed right away, so a transaction around the migration wouldn't help. When a migration fails after changing something, Gina:

1. lists what was applied before the error, e.g. `addColumn users.nickname`;
2. records the failure in a `gina_failure` table, and keeps `gina_version` at the previous migration;
3. refuses to run `upgrade` or `downgrade` until the failure is repaired, so nothing runs on top of a half-applied migration.

If it fails before changing anything, there's nothing to repair: fix it and run `upgrade` again.

### `gina-cli repair --continue | --rollback`

Finishes or undoes the migration that failed halfway. Fix the cause first (e.g. remove the duplicates that broke a unique index, or fix the migration), then:

- `--continue` runs the migration again and moves the version forward;
- `--rollback` runs its `down`, undoing what was applied.

Either way, each operation is checked before it runs and skipped when the database is already the way it would leave it: a column that already exists isn't added again, an index that was never created isn't removed. Skipped operations are logged, e.g. `skipped: addColumn users.nickname (column users.nickname already exists)`. Any other error still fails.

The check is by name, for the `QueryInterface` methods that create, drop, rename, add or remove tables, columns, indexes and constraints; `changeColumn` always runs again, which is harmless. Raw queries (`queryInterface.sequelize.query`) and bulk operations can't be checked and would run again, so `repair` refuses migrations with them unless you review it and pass `--yes`.

### `gina-cli downgrade [steps] [--to <migration>]`

Reverts applied migrations, newest first, running each one's `down` and updating `gina_version` after each one.

```bash
npx gina-cli downgrade                       # reverts the last migration
npx gina-cli downgrade 3                     # reverts the last 3 migrations
npx gina-cli downgrade --to 20240531183010   # reverts every migration after 20240531183010-*
```

`--to` takes the migration to go back to, which stays applied. It can be the full name or any prefix that matches only one migration, like its timestamp.

The first migration (the one `init` creates) is never reverted, because it creates the `gina_version` table. Gina checks the whole request before reverting anything: if you ask for more migrations than can be reverted, or one of them has no `down`, nothing runs.

### `gina-cli check`

Checks that the migrations form a single chain and that `HEAD` names the last one. It loads the migration files but doesn't connect to the database, so it fits in CI.

### `gina-cli snapshot`

Runs every migration on a temporary database (MySQL/MariaDB) and writes the resulting schema to `snapshot.sql` (see `snapshotFile`), with the version it's at. Then `gina-cli upgrade --from-snapshot` creates a new development database from it in one go, and applies only the migrations added after the snapshot was taken, so it doesn't need to be regenerated with every migration.

The migrations stay the source of truth, and everything else keeps using them: production, `downgrade` (a database created from the snapshot can still be downgraded) and `upgrade` without the flag. The snapshot has no data: if a migration inserts or changes rows, `snapshot` lists it so you know that data is missing.

### `gina-cli generate-migration "<name>"`

Loads your models, compares them with the database the environment variables point to, and writes `<migrationsDir>/<timestamp>-<name>.ts`. If there are no differences, no file is written.

Point it at a database that is up to date (run `upgrade` first; Gina refuses otherwise). Gina writes whatever is different between your models and that database. The new migration runs after the last one (`previous`) and becomes `HEAD`.

It detects:

- new and removed tables
- new and removed columns
- changes to existing columns (MySQL/MariaDB only): type, including length and enum values (e.g. adding a value to an `ENUM`), nullability and default value. These become `changeColumn` calls. `up` uses the model's definition and `down` restores the column as it was in the database.
- foreign keys of new columns
- new and removed indexes, including ordered fields like `{ name: 'time', order: 'DESC' }` and unique indexes declared on the attribute (`unique: true`, or `unique: 'name'` for a composite one). Those are matched by their columns, since the database may have named them differently

On MySQL/MariaDB, defaults of `TEXT`, `BLOB`, `JSON` and `GEOMETRY` columns are left out: MySQL can't store them, so a model default like `defaultValue: ''` only applies when Sequelize creates a row.

Column types are written with their parameters, e.g. `DataTypes.ENUM('draft', 'published')`, `DataTypes.STRING(100)` or `DataTypes.DECIMAL(10, 2)`. Enum values are written into the migration instead of importing the enum from your code, so the migration keeps working after the enum changes again.

Remember that Sequelize considers a column nullable unless the attribute says `allowNull: false`. That includes attributes created by associations (`foreignKey: 'userId'`) and shorthand timestamps (`createdAt: DataTypes.DATE`). If the database has them as `NOT NULL`, Gina reports the difference. Declare `allowNull: false` in the model (for associations, `foreignKey: { name: 'userId', allowNull: false }`) if that's what you want.

The generated `down` undoes the `up`, so `downgrade` brings the schema back to what it was: foreign keys added by the migration are removed first, and dropped columns are added back at their original position (MySQL/MariaDB).

**Always review the generated file.** Gina doesn't detect renames (they show up as a drop plus an add), changes to foreign keys, primary keys or auto increment of existing columns. Write those parts by hand.

## Using it in production

Install dependencies, build, and run `upgrade` from the folder that has `package.json` and the compiled output. For example, as a Kubernetes job or Helm hook that runs before the new pods start:

```yaml
command: ["npx", "gina-cli", "upgrade"]
```

No TypeScript tooling is needed at runtime if the migrations and models are compiled to `.js`.

To catch problems before they reach the database, run a rehearsal first; the real `upgrade` only runs if it passes:

```bash
npx gina-cli upgrade --dry-run && npx gina-cli upgrade
```

If a migration still fails halfway, see [When a migration fails halfway](#when-a-migration-fails-halfway).

## Development

```bash
npm install
npm run build
npm run eslint
```

### End-to-end tests

`e2e/run.sh` tests Gina the way a user would: it packs Gina, installs the tarball into a separate project (`e2e/fixture`) and, against a new schema with a random name, runs:

1. `init` and `upgrade` on an empty database
2. `generate-migration` and `upgrade` with the initial models, then compares the schema with `e2e/expected/v1.json`
3. `generate-migration` again, which must not create a file
4. a model change (`e2e/changes`), then `generate-migration` and `upgrade`, then compares the schema with `e2e/expected/v2.json`
5. `downgrade`, `downgrade 2` and `downgrade --to`, comparing the schema after each one (`v1.json`, and `base.json` for only the version table), and checking that a `downgrade` beyond the first migration is refused without changing anything
6. the migration chain: a migration from a branch merged late (`e2e/scenarios/late-branch.ts`) is refused by `check`, `upgrade` and `generate-migration` until it runs after the last one, and then runs even though its name sorts first
7. a migration that fails halfway (`e2e/scenarios/fails-halfway.ts`): `upgrade --dry-run` catches it without touching the database, the real `upgrade` records it, `upgrade` and `downgrade` refuse to run, and `repair --rollback` and `repair --continue` each bring the schema to the expected state
8. `snapshot` and `upgrade --from-snapshot` on a new database, with a migration added after the snapshot, then `downgrade` from there
9. `upgrade` from the compiled `.js` only (production-like) on a new database, then compares the schema with `e2e/expected/v2.json`

It needs a MySQL server:

```bash
docker run -d --name gina-mysql -e MYSQL_ROOT_PASSWORD=root -p 3306:3306 mysql:8.0
npm run test:e2e
```

Connection settings come from `DB_HOST`, `DB_PORT`, `DB_USERNAME` and `DB_PASSWORD` (defaults: `127.0.0.1`, `3306`, `root`, `root`). After an intended change to the generated schema, run `UPDATE_SNAPSHOTS=1 npm run test:e2e` and review the diff in `e2e/expected/`.

### CI and releases

`.github/workflows/e2e.yml` runs lint and the end-to-end suite against MySQL 8.0 on Node 18, 20.10.0, 20, 22 and 24, in parallel, on every push and pull request.

Publishing to npm (`.github/workflows/npm-publish.yml`, triggered by creating a GitHub release) runs the same suite first. If it fails on any Node version, the package isn't published.

The publish job authenticates with npm through [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC), configured on the package settings at npmjs.com for `digital-divas/gina` and `npm-publish.yml`. No npm token is stored in the repository. To release, bump `version` in `package.json`, merge, and create a GitHub release for that version.
