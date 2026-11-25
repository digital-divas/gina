/**
 * Applies and reverts migrations: the migration chain, the version stored in the database,
 * failures halfway through a migration (`repair`) and dry runs.
 */
import fs from 'fs/promises';
import { DataTypes, Options, QueryInterface, QueryTypes, Sequelize } from 'sequelize';
import { MigrationFile } from './typings/migration';

interface MigrationEntry {
    migration: MigrationFile;
    /**
     * Migration this one runs after (`export const previous = '...'`). Migrations without it are
     * ordered by name, the way gina worked before the chain existed.
     */
    previous?: string | null;
    /** source file, used to warn about statements `repair` can't check */
    filePath?: string;
}

interface MigrationFiles {
    [name: string]: MigrationEntry;
}

interface DowngradeTarget {
    /** how many migrations to revert */
    steps?: number;
    /** migration to go back to (it stays applied): its full name or a unique prefix, like its timestamp */
    to?: string;
}

type Direction = 'up' | 'down';

interface Failure {
    migration: string;
    direction: Direction;
    error: string;
    failedAt: Date;
}

const FAILURE_TABLE = 'gina_failure';

/** Operations `repair` checks before running, and that are listed when a migration fails. */
const OPERATIONS = [
    'createTable', 'dropTable', 'renameTable',
    'addColumn', 'removeColumn', 'changeColumn', 'renameColumn',
    'addIndex', 'removeIndex', 'addConstraint', 'removeConstraint',
    'bulkInsert', 'bulkUpdate', 'bulkDelete',
];

/**
 * Versions used to be saved with the file extension when migrations ran from compiled .js files
 * (e.g. `20240101000000-foo.js`), so they're compared without it.
 */
function stripExtension(version: string) {
    return version.replace(/\.[cm]?[jt]s$/, '');
}

function normalize(migrationFiles: MigrationFiles) {
    const entries = new Map<string, MigrationEntry>();
    for (const [name, entry] of Object.entries(migrationFiles)) {
        entries.set(stripExtension(name), entry);
    }
    return entries;
}

class ChainError extends Error {}

/**
 * The order migrations run in. Each migration runs after its `previous`; migrations without one
 * run first, by name. Fails when two migrations come after the same one (usually two branches that
 * each added a migration), when a `previous` doesn't exist, or when there's a cycle.
 */
function resolveOrder(migrationFiles: MigrationFiles) {
    const entries = normalize(migrationFiles);
    const names = [...entries.keys()].sort();
    const previousOf = new Map<string, string | undefined>();

    const roots = names.filter(name => !entries.get(name)?.previous);
    roots.forEach((name, index) => previousOf.set(name, roots[index - 1]));

    for (const name of names) {
        const previous = entries.get(name)?.previous;
        if (!previous) {
            continue;
        }
        if (!entries.has(stripExtension(previous))) {
            throw new ChainError(`${name} runs after ${previous}, but there's no migration with that name.`);
        }
        previousOf.set(name, stripExtension(previous));
    }

    const next = new Map<string | undefined, string[]>();
    for (const [name, previous] of previousOf) {
        next.set(previous, [...next.get(previous) ?? [], name]);
    }

    for (const [previous, children] of next) {
        if (previous !== undefined && children.length > 1) {
            throw new ChainError(`${children.join(' and ')} all run right after ${previous}. This usually happens when `
                + 'two branches add a migration at the same time. Make them run one after the other: '
                + 'set `export const previous` on the newer one to the last migration of the other, and update the HEAD file.');
        }
    }

    const order: string[] = [];
    let current = next.get(undefined)?.[0];
    while (current !== undefined && !order.includes(current)) {
        order.push(current);
        current = next.get(current)?.[0];
    }

    if (order.length !== names.length) {
        const unreachable = names.filter(name => !order.includes(name));
        throw new ChainError(`The migration chain has a cycle: ${unreachable.join(', ')}.`);
    }

    return { order, entries };
}

function tableName(table: unknown) {
    return typeof table === 'string' ? table : (table as { tableName: string; }).tableName;
}

async function tableExists(queryInterface: QueryInterface, table: unknown) {
    const tables = await queryInterface.showAllTables() as unknown[];
    return tables.map(tableName).includes(tableName(table));
}

async function readVersion(sequelize: Sequelize) {
    if (!await tableExists(sequelize.getQueryInterface(), 'gina_version')) {
        return '';
    }

    const versions: { version: string; }[] = await sequelize.query('SELECT version FROM gina_version;', {
        type: QueryTypes.SELECT,
    });

    if (versions.length > 1) {
        throw new Error('There must be only one version on `gina_version` table.');
    }

    return versions.length == 1 ? stripExtension(versions[0].version) : '';
}

async function saveVersion(sequelize: Sequelize, version: string, updateAtFieldName: string) {
    const [rows] = await sequelize.query('SELECT version FROM gina_version;') as unknown[][];
    if (rows.length) {
        await sequelize.query(`UPDATE gina_version SET version = ?, ${updateAtFieldName} = NOW();`, { replacements: [version] });
    } else {
        await sequelize.query(`INSERT INTO gina_version (${updateAtFieldName}, version) VALUES (NOW(), ?);`, { replacements: [version] });
    }
}

/**
 * Index (in `order`) of the version the database is at, -1 when it has none.
 */
function versionIndex(order: string[], entries: Map<string, MigrationEntry>, version: string) {
    if (!version) {
        return -1;
    }
    const index = order.indexOf(version);
    if (index !== -1) {
        return index;
    }
    // before the chain, versions were only compared by name, so a database can be at a migration
    // whose file was removed since
    if ([...entries.values()].every(entry => !entry.previous)) {
        return order.filter(name => name <= version).length - 1;
    }
    throw new Error(`The database is at ${version}, which doesn't match any migration file.`);
}

async function readFailure(sequelize: Sequelize): Promise<Failure | undefined> {
    if (!await tableExists(sequelize.getQueryInterface(), FAILURE_TABLE)) {
        return undefined;
    }
    const failures: Failure[] = await sequelize.query(`SELECT migration, direction, error, failedAt FROM ${FAILURE_TABLE};`, {
        type: QueryTypes.SELECT,
    });
    return failures[0];
}

async function recordFailure(sequelize: Sequelize, failure: Omit<Failure, 'failedAt'>) {
    try {
        await sequelize.getQueryInterface().createTable(FAILURE_TABLE, {
            migration: { type: DataTypes.STRING, allowNull: false },
            direction: { type: DataTypes.STRING(4), allowNull: false },
            error: { type: DataTypes.TEXT, allowNull: true },
            failedAt: { type: DataTypes.DATE, allowNull: false },
        });
        await sequelize.query(`DELETE FROM ${FAILURE_TABLE};`);
        await sequelize.query(`INSERT INTO ${FAILURE_TABLE} (migration, direction, error, failedAt) VALUES (?, ?, ?, NOW());`, {
            replacements: [failure.migration, failure.direction, failure.error],
        });
    } catch (err) {
        console.error(`could not record the failure on the ${FAILURE_TABLE} table:`, (err as Error).message);
    }
}

function failureHelp(failure: Pick<Failure, 'migration' | 'direction'>) {
    return `Migration ${failure.migration} failed halfway (${failure.direction}), so part of it may have been applied. `
        + 'Fix the cause, then run `gina-cli repair --continue` to finish it, '
        + 'or `gina-cli repair --rollback` to undo what was applied.';
}

async function assertNoFailure(sequelize: Sequelize) {
    const failure = await readFailure(sequelize);
    if (failure) {
        throw new Error(`${failureHelp(failure)}\nThe error was: ${failure.error}`);
    }
}

function describeOperation(method: string, args: unknown[]) {
    const table = args.length ? tableName(args[0]) : '';
    const options = (value: unknown) => (value && typeof value === 'object' ? value as { name?: string; type?: string; fields?: unknown[]; } : {});

    switch (method) {
        case 'addColumn':
        case 'removeColumn':
        case 'changeColumn':
            return `${method} ${table}.${args[1]}`;
        case 'renameColumn':
            return `${method} ${table}.${args[1]} -> ${args[2]}`;
        case 'renameTable':
            return `${method} ${table} -> ${tableName(args[1])}`;
        case 'addIndex':
            return `${method} ${table} ${options(args[2]).name ?? options(args[1]).name ?? JSON.stringify(args[1])}`;
        case 'removeIndex':
        case 'removeConstraint':
            return `${method} ${table} ${typeof args[1] === 'string' ? args[1] : JSON.stringify(args[1])}`;
        case 'addConstraint':
            return `${method} ${table} ${options(args[1]).name ?? options(args[1]).type}`;
    }
    return `${method} ${table}`;
}

/**
 * Why an operation can be skipped on `repair` because the database is already the way it would leave it,
 * or `undefined` when it has to run. Only checks by name; anything else still runs and may fail.
 */
async function alreadyApplied(queryInterface: QueryInterface, method: string, args: unknown[]): Promise<string | undefined> {
    const table = tableName(args[0]);
    const columns = async () => (await tableExists(queryInterface, table) ? queryInterface.describeTable(table) : undefined);
    const indexes = async () => (await tableExists(queryInterface, table)
        ? (await queryInterface.showIndex(table) as { name: string; }[]).map(index => index.name)
        : []);
    const constraintExists = async (name: string) => {
        if (!['mysql', 'mariadb'].includes(queryInterface.sequelize.getDialect())) {
            return undefined;
        }
        const rows = await queryInterface.sequelize.query(`
            SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`, {
            type: QueryTypes.SELECT,
            replacements: [table, name],
        });
        return rows.length > 0;
    };

    switch (method) {
        case 'createTable':
            return await tableExists(queryInterface, table) ? `table ${table} already exists` : undefined;
        case 'dropTable':
            return await tableExists(queryInterface, table) ? undefined : `table ${table} doesn't exist`;
        case 'renameTable':
            return !await tableExists(queryInterface, table) && await tableExists(queryInterface, args[1])
                ? `table ${table} was already renamed to ${tableName(args[1])}`
                : undefined;
        case 'addColumn':
            return (await columns())?.[args[1] as string] ? `column ${table}.${args[1]} already exists` : undefined;
        case 'removeColumn':
            return (await columns())?.[args[1] as string] ? undefined : `column ${table}.${args[1]} doesn't exist`;
        case 'renameColumn': {
            const description = await columns();
            return description && !description[args[1] as string] && description[args[2] as string]
                ? `column ${table}.${args[1]} was already renamed to ${args[2]}`
                : undefined;
        }
        case 'addIndex': {
            const name = (args[2] as { name?: string; } | undefined)?.name ?? (args[1] as { name?: string; }).name;
            return name && (await indexes()).includes(name) ? `index ${name} already exists` : undefined;
        }
        case 'removeIndex':
            return typeof args[1] === 'string' && !(await indexes()).includes(args[1]) ? `index ${args[1]} doesn't exist` : undefined;
        case 'addConstraint': {
            const name = (args[1] as { name?: string; }).name;
            return name && await constraintExists(name) ? `constraint ${name} already exists` : undefined;
        }
        case 'removeConstraint':
            return typeof args[1] === 'string' && await constraintExists(args[1]) === false
                ? `constraint ${args[1]} doesn't exist`
                : undefined;
    }
    return undefined;
}

/**
 * The QueryInterface handed to a migration: it records each operation that completes, so a failure
 * can tell what was applied, and on `repair` skips the operations that were already applied.
 */
function instrument(queryInterface: QueryInterface, applied: string[], repairing: boolean): QueryInterface {
    const sequelize = new Proxy(queryInterface.sequelize, {
        get(target, prop) {
            const value = Reflect.get(target, prop);
            if (prop === 'query') {
                return async (...args: Parameters<Sequelize['query']>) => {
                    const description = `query ${String(args[0]).replace(/\s+/g, ' ').trim().slice(0, 80)}`;
                    if (repairing) {
                        console.warn(`running again: ${description}`);
                    }
                    const result = await target.query(...args);
                    applied.push(description);
                    return result;
                };
            }
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });

    return new Proxy(queryInterface, {
        get(target, prop) {
            if (prop === 'sequelize') {
                return sequelize;
            }
            const value = Reflect.get(target, prop);
            if (typeof value !== 'function') {
                return value;
            }
            if (typeof prop !== 'string' || !OPERATIONS.includes(prop)) {
                return value.bind(target);
            }
            return async (...args: unknown[]) => {
                const description = describeOperation(prop, args);
                if (repairing) {
                    const reason = await alreadyApplied(target, prop, args);
                    if (reason) {
                        console.info(`skipped: ${description} (${reason})`);
                        return undefined;
                    }
                }
                const result = await value.apply(target, args);
                applied.push(description);
                return result;
            };
        },
    });
}

interface RunOptions {
    /** record a failure halfway through a migration on the database, so the next run asks for `repair` */
    recordFailures?: boolean;
    repairing?: boolean;
    /** don't log each migration */
    quiet?: boolean;
}

async function runMigration(sequelize: Sequelize, name: string, entry: MigrationEntry, direction: Direction, options: RunOptions) {
    const run = entry.migration[direction];
    if (typeof run !== 'function') {
        throw new Error(`${name} doesn't have a ${direction} function.`);
    }

    const applied: string[] = [];
    try {
        await run.call(entry.migration, instrument(sequelize.getQueryInterface(), applied, Boolean(options.repairing)));
    } catch (err) {
        if (!applied.length) {
            console.error(`${name} failed (${direction}) before changing anything.`);
            throw err;
        }
        console.error(`${name} failed (${direction}). Applied before the error:\n${applied.map(step => `  - ${step}`).join('\n')}`);
        if (options.recordFailures !== false) {
            await recordFailure(sequelize, { migration: name, direction, error: (err as Error).message });
            console.error(failureHelp({ migration: name, direction }));
        }
        throw err;
    }
}

async function runMigrations(sequelize: Sequelize, migrationFiles: MigrationFiles, updateAtFieldName?: string, options: RunOptions = {}) {
    const updatedAt = updateAtFieldName || 'updatedAt';
    await assertNoFailure(sequelize);

    const { order, entries } = resolveOrder(migrationFiles);
    const version = await readVersion(sequelize);
    const log = options.quiet ? () => undefined : console.info;
    log('current version:', version);

    for (const name of order.slice(versionIndex(order, entries, version) + 1)) {
        log('applying migration:', name);
        await runMigration(sequelize, name, entries.get(name) as MigrationEntry, 'up', options);
        await saveVersion(sequelize, name, updatedAt);
        log('applied version:', name);
    }
}

/**
 * Reverts applied migrations, newest first, running their `down` functions.
 * The first migration is never reverted: it creates the `gina_version` table that holds the version.
 */
async function revertMigrations(sequelize: Sequelize, migrationFiles: MigrationFiles, target: DowngradeTarget, updateAtFieldName = 'updatedAt') {
    await assertNoFailure(sequelize);

    const { order, entries } = resolveOrder(migrationFiles);
    const version = await readVersion(sequelize);
    console.info('current version:', version);

    if (!version) {
        throw new Error('There are no applied migrations to downgrade.');
    }
    const current = order.indexOf(version);
    if (current === -1) {
        throw new Error(`The current version ${version} doesn't match any migration file.`);
    }

    let targetIndex: number;
    if (target.to !== undefined) {
        const to = stripExtension(target.to);
        const matches = order.filter(name => name.startsWith(to));
        const exact = order.indexOf(to);
        if (exact === -1 && matches.length !== 1) {
            throw new Error(matches.length
                ? `"${target.to}" matches more than one migration: ${matches.join(', ')}.`
                : `There's no migration named "${target.to}".`);
        }
        targetIndex = exact !== -1 ? exact : order.indexOf(matches[0]);
        if (targetIndex > current) {
            throw new Error(`${order[targetIndex]} isn't applied yet (current version is ${version}). Use upgrade instead.`);
        }
    } else {
        const steps = target.steps ?? 1;
        if (!Number.isInteger(steps) || steps < 1) {
            throw new Error('The number of migrations to downgrade must be a positive integer.');
        }
        targetIndex = current - steps;
    }

    if (targetIndex < 0) {
        throw new Error(`Can't downgrade ${current - targetIndex} migration(s): only ${current} can be reverted, `
            + `the first one (${order[0]}) creates the gina_version table.`);
    }

    const toRevert = order.slice(targetIndex + 1, current + 1).reverse();
    if (!toRevert.length) {
        console.info('Nothing to downgrade.');
        return;
    }

    const withoutDown = toRevert.filter(name => typeof entries.get(name)?.migration.down !== 'function');
    if (withoutDown.length) {
        throw new Error(`These migrations don't have a down function: ${withoutDown.join(', ')}.`);
    }

    for (const name of toRevert) {
        const previous = order[order.indexOf(name) - 1];
        console.info('reverting migration:', name);
        await runMigration(sequelize, name, entries.get(name) as MigrationEntry, 'down', {});
        await saveVersion(sequelize, previous, updateAtFieldName);
        console.info('current version:', previous);
    }
}

/**
 * Finishes (`continue`) or undoes (`rollback`) a migration that failed halfway, running it again
 * while skipping the operations that are already applied.
 */
async function repairMigration(sequelize: Sequelize, migrationFiles: MigrationFiles, mode: 'continue' | 'rollback', options: { yes?: boolean; } = {}, updateAtFieldName = 'updatedAt') {
    const failure = await readFailure(sequelize);
    if (!failure) {
        console.info('Nothing to repair: no migration failed halfway.');
        return;
    }

    const { order, entries } = resolveOrder(migrationFiles);
    const entry = entries.get(failure.migration);
    if (!entry) {
        throw new Error(`${failure.migration} failed halfway, but there's no migration file with that name.`);
    }

    console.info(`${failure.migration} failed halfway (${failure.direction}) on ${new Date(failure.failedAt).toISOString()}: ${failure.error}`);

    if (entry.filePath && !options.yes) {
        const source = await fs.readFile(entry.filePath, 'utf8');
        if (/\.(query|bulkInsert|bulkUpdate|bulkDelete)\s*\(/.test(source)) {
            throw new Error(`${failure.migration} runs raw queries or bulk operations. repair can't tell whether they were `
                + 'already applied, so it would run them again. Review the migration and run repair again with --yes.');
        }
    }

    const direction: Direction = mode === 'continue'
        ? failure.direction
        : failure.direction === 'up' ? 'down' : 'up';
    const previous = order[order.indexOf(failure.migration) - 1];

    console.info(`${mode === 'continue' ? 'finishing' : 'undoing'} ${failure.migration} (${direction})...`);
    await runMigration(sequelize, failure.migration, entry, direction, { recordFailures: false, repairing: true });

    const version = direction === 'up' ? failure.migration : previous;
    if (version) {
        await saveVersion(sequelize, version, updateAtFieldName);
    }
    await sequelize.getQueryInterface().dropTable(FAILURE_TABLE);
    console.info('repaired. current version:', version);
}

function assertMySQL(sequelize: Sequelize, feature: string) {
    if (!['mysql', 'mariadb'].includes(sequelize.getDialect())) {
        throw new Error(`${feature} is only supported on MySQL and MariaDB.`);
    }
}

/**
 * A Sequelize instance for another database on the same server, with a single connection
 * so session settings like FOREIGN_KEY_CHECKS apply to every statement.
 */
function connect(sequelize: Sequelize, database: string) {
    const SequelizeClass = sequelize.constructor as typeof Sequelize;
    return new SequelizeClass(database, sequelize.config.username, sequelize.config.password ?? undefined, {
        ...(sequelize as unknown as { options: Options; }).options,
        logging: false,
        pool: { max: 1, min: 0 },
    });
}

/** Runs `callback` on a new, temporary database, which is dropped at the end. */
async function withTemporaryDatabase<T>(sequelize: Sequelize, feature: string, callback: (temporary: Sequelize, name: string) => Promise<T>) {
    const name = `gina_tmp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    try {
        await sequelize.query(`CREATE DATABASE \`${name}\`;`);
    } catch (err) {
        throw new Error(`${feature} needs permission to create and drop databases: ${(err as Error).message}`);
    }

    const temporary = connect(sequelize, name);
    try {
        return await callback(temporary, name);
    } finally {
        await temporary.close();
        await sequelize.query(`DROP DATABASE IF EXISTS \`${name}\`;`);
    }
}

/** `CREATE TABLE` statements of every table, without AUTO_INCREMENT counters. */
async function showCreateTables(sequelize: Sequelize) {
    const tables: { [column: string]: string; }[] = await sequelize.query('SHOW FULL TABLES WHERE Table_type = \'BASE TABLE\';', {
        type: QueryTypes.SELECT,
    });
    const statements: { table: string; sql: string; }[] = [];
    for (const table of tables.map(row => Object.values(row)[0]).sort()) {
        const [definition]: { 'Create Table': string; }[] = await sequelize.query(`SHOW CREATE TABLE \`${table}\`;`, {
            type: QueryTypes.SELECT,
        });
        statements.push({ table, sql: definition['Create Table'].replace(/ AUTO_INCREMENT=\d+/, '') });
    }
    return statements;
}

async function createTables(sequelize: Sequelize, statements: string[]) {
    await sequelize.query('SET FOREIGN_KEY_CHECKS = 0;');
    for (const statement of statements) {
        await sequelize.query(statement);
    }
    await sequelize.query('SET FOREIGN_KEY_CHECKS = 1;');
}

/**
 * Applies the pending migrations to a copy of the database's schema (no data) in a temporary
 * database, which is dropped at the end. MySQL/MariaDB only.
 */
async function dryRunMigrations(sequelize: Sequelize, migrationFiles: MigrationFiles, updateAtFieldName?: string) {
    assertMySQL(sequelize, '--dry-run');
    await assertNoFailure(sequelize);

    const { order, entries } = resolveOrder(migrationFiles);
    const version = await readVersion(sequelize);
    const pending = order.slice(versionIndex(order, entries, version) + 1);
    if (!pending.length) {
        console.info('dry run: there are no pending migrations.');
        return;
    }

    const database = sequelize.config.database;
    await withTemporaryDatabase(sequelize, '--dry-run', async (copy, copyName) => {
        console.info(`dry run: copying the schema of ${database} (without data) to ${copyName}...`);
        const tables = await showCreateTables(sequelize);
        await createTables(copy, tables.map(table => table.sql));
        if (tables.some(table => table.table === 'gina_version')) {
            await copy.query(`INSERT INTO gina_version SELECT * FROM \`${database}\`.gina_version;`);
        }

        console.info(`dry run: applying ${pending.length} migration(s)...`);
        try {
            await runMigrations(copy, migrationFiles, updateAtFieldName, { recordFailures: false });
        } catch (err) {
            console.error(`dry run failed. Nothing was changed on ${database}.`);
            throw err;
        }
    });

    console.info(`dry run passed: ${pending.length} migration(s) applied cleanly to a copy of the schema. Nothing was changed on ${database}.`);
    console.info('Errors that depend on the data can still happen, like duplicates on a new unique index or NULLs on a column that becomes NOT NULL.');
}

const SNAPSHOT_HEADER = `-- Generated by \`gina-cli snapshot\`: the schema after every migration up to the version below.
-- \`gina-cli upgrade --from-snapshot\` creates it on an empty database and then runs only the migrations after it.
-- Meant for development databases; the migrations are still the source of truth. Don't edit by hand.
`;

/**
 * Runs every migration on a temporary database and writes the resulting schema to `snapshotFile`.
 * Data inserted by migrations isn't part of it.
 */
async function createSnapshot(sequelize: Sequelize, migrationFiles: MigrationFiles, snapshotFile: string, updateAtFieldName?: string) {
    assertMySQL(sequelize, 'snapshot');
    const { order, entries } = resolveOrder(migrationFiles);
    if (!order.length) {
        throw new Error('There are no migrations to snapshot.');
    }

    const withData: string[] = [];
    for (const name of order) {
        const filePath = entries.get(name)?.filePath;
        if (filePath && /\.(query|bulkInsert|bulkUpdate|bulkDelete)\s*\(/.test(await fs.readFile(filePath, 'utf8'))) {
            withData.push(name);
        }
    }

    const statements = await withTemporaryDatabase(sequelize, 'snapshot', async (temporary) => {
        console.info(`snapshot: running ${order.length} migration(s) on a temporary database...`);
        await runMigrations(temporary, migrationFiles, updateAtFieldName, { recordFailures: false, quiet: true });
        return showCreateTables(temporary);
    });

    const version = order[order.length - 1];
    await fs.writeFile(snapshotFile, `${SNAPSHOT_HEADER}-- version: ${version}\n\n${statements.map(statement => `${statement.sql};`).join('\n\n')}\n`);
    console.info(`snapshot written: ${snapshotFile} (version ${version}, ${statements.length} tables)`);

    if (withData.length) {
        console.warn('These migrations run raw queries or bulk operations. If they insert or change data, '
            + `that data isn't in the snapshot:\n${withData.map(name => `  - ${name}`).join('\n')}`);
    }
}

/**
 * Creates the schema from a snapshot on an empty database, then applies the migrations after it.
 */
async function upgradeFromSnapshot(sequelize: Sequelize, migrationFiles: MigrationFiles, snapshotFile: string, updateAtFieldName = 'updatedAt') {
    assertMySQL(sequelize, '--from-snapshot');

    let content: string;
    try {
        content = await fs.readFile(snapshotFile, 'utf8');
    } catch {
        throw new Error(`Snapshot not found: ${snapshotFile}. Create it with \`gina-cli snapshot\`.`);
    }
    const version = /^-- version: (.+)$/m.exec(content)?.[1]?.trim();
    if (!version) {
        throw new Error(`${snapshotFile} doesn't say which version it's at. Create it again with \`gina-cli snapshot\`.`);
    }

    const tables = await sequelize.getQueryInterface().showAllTables();
    if (tables.length) {
        throw new Error(`--from-snapshot only works on an empty database, and ${sequelize.config.database} has ${tables.length} table(s). `
            + 'Use upgrade without it, or start from an empty database.');
    }

    const { order } = resolveOrder(migrationFiles);
    if (!order.includes(version)) {
        throw new Error(`The snapshot is at ${version}, which doesn't match any migration file. Create it again with \`gina-cli snapshot\`.`);
    }

    const statements = content
        .split('\n')
        .filter(line => !line.startsWith('--'))
        .join('\n')
        .split(/;\n\n/)
        .map(statement => statement.trim().replace(/;$/, ''))
        .filter(Boolean);

    console.info(`creating ${statements.length} tables from ${snapshotFile} (version ${version})...`);
    const connection = connect(sequelize, sequelize.config.database);
    try {
        await createTables(connection, statements);
    } finally {
        await connection.close();
    }
    await saveVersion(sequelize, version, updateAtFieldName);

    await runMigrations(sequelize, migrationFiles, updateAtFieldName);
}

export {
    MigrationEntry,
    MigrationFiles,
    DowngradeTarget,
    ChainError,
    stripExtension,
    resolveOrder,
    readVersion,
    runMigrations,
    revertMigrations,
    repairMigration,
    dryRunMigrations,
    createSnapshot,
    upgradeFromSnapshot,
};
