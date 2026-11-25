# Gina

Gina is a migration tool for [Sequelize](https://sequelize.org/) projects, in the spirit of Python's Alembic:

- **`generate-migration`** compares your Sequelize models with a live database and writes a migration file with the differences.
- **`upgrade`** applies every pending migration, in order, and records the current version in the database.

It's a regular CLI. You install it in your project and run it from the project folder, locally while developing and in production as a deploy step. It works with migrations and models written in TypeScript or in plain/compiled JavaScript, on any Node version from 18 up.

## How it works

When you run `gina-cli`, it:

1. Reads the `gina` section of the `package.json` in the current folder.
2. Connects to the database using the `DB_*` environment variables (and a `.env` file, if there is one).
3. Loads every model file in `modelsDir` and calls the `initializeModel(sequelize)` function each one exports.
4. Loads the migration files in `migrationsDir`, sorted by file name.
5. Runs the command.

**TypeScript files** are transpiled on the fly with your project's own `typescript` package and `tsconfig.json`. Gina only transpiles them, it doesn't type-check, and it doesn't need `ts-node`, `tsx` or any Node loader flags. That's why it behaves the same on every Node version.

**JavaScript files** are loaded as they are. In production you can ship only the compiled output (`.js`) and run `gina-cli upgrade` there without TypeScript sources.

When the same migration exists as both `.ts` and `.js`, the `.ts` one is used.

### Version control

Gina keeps a single row in a `gina_version` table with the name of the last applied migration, e.g. `20240531183010-adding-initial-structure`. `upgrade` runs every migration whose name sorts after that version, so migration files must start with a sortable timestamp. Gina's generated file names already do.

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

A migration exports `migration` with `up` and `down` functions that receive Sequelize's `QueryInterface`:

```ts
import { QueryInterface, DataTypes } from 'sequelize';

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

Creates `gina/migrations` with the first migration, which creates the `gina_version` table. Then set `gina.modelsDir` in your `package.json`.

### `gina-cli upgrade`

Applies every pending migration in order, updating `gina_version` after each one. Run it on deploy, before the new version of the app starts.

### `gina-cli generate-migration "<name>"`

Loads your models, compares them with the database the environment variables point to, and writes `<migrationsDir>/<timestamp>-<name>.ts`. If there are no differences, no file is written.

Point it at a database that is up to date (run `upgrade` first). Gina writes whatever is different between your models and that database.

It detects:

- new and removed tables
- new and removed columns
- changes to existing columns (MySQL/MariaDB only): type, including length and enum values (e.g. adding a value to an `ENUM`), nullability and default value. These become `changeColumn` calls. `up` uses the model's definition and `down` restores the column as it was in the database.
- foreign keys of new columns
- new and removed indexes, including ordered fields like `{ name: 'time', order: 'DESC' }`

Column types are written with their parameters, e.g. `DataTypes.ENUM('draft', 'published')`, `DataTypes.STRING(100)` or `DataTypes.DECIMAL(10, 2)`. Enum values are written into the migration instead of importing the enum from your code, so the migration keeps working after the enum changes again.

Remember that Sequelize considers a column nullable unless the attribute says `allowNull: false`. That includes attributes created by associations (`foreignKey: 'userId'`) and shorthand timestamps (`createdAt: DataTypes.DATE`). If the database has them as `NOT NULL`, Gina reports the difference. Declare `allowNull: false` in the model (for associations, `foreignKey: { name: 'userId', allowNull: false }`) if that's what you want.

**Always review the generated file.** Gina doesn't detect renames (they show up as a drop plus an add), changes to foreign keys, primary keys or auto increment of existing columns. Write those parts by hand.

## Using it in production

Install dependencies, build, and run `upgrade` from the folder that has `package.json` and the compiled output. For example, as a Kubernetes job or Helm hook that runs before the new pods start:

```yaml
command: ["npx", "gina-cli", "upgrade"]
```

No TypeScript tooling is needed at runtime if the migrations and models are compiled to `.js`.

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
5. `upgrade` from the compiled `.js` only (production-like) on a new database, then compares the schema with `e2e/expected/v2.json`

It needs a MySQL server:

```bash
docker run -d --name gina-mysql -e MYSQL_ROOT_PASSWORD=root -p 3306:3306 mysql:8.0
npm run test:e2e
```

Connection settings come from `DB_HOST`, `DB_PORT`, `DB_USERNAME` and `DB_PASSWORD` (defaults: `127.0.0.1`, `3306`, `root`, `root`). After an intended change to the generated schema, run `UPDATE_SNAPSHOTS=1 npm run test:e2e` and review the diff in `e2e/expected/`.

### CI and releases

`.github/workflows/e2e.yml` runs lint and the end-to-end suite against MySQL 8.0 on Node 18, 20.10.0, 20, 22 and 24, in parallel, on every push and pull request.

Publishing to npm (`.github/workflows/npm-publish.yml`, triggered by creating a GitHub release) runs the same suite first. If it fails on any Node version, the package isn't published.
