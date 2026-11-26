import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import moment from 'moment';
import type { Options, Sequelize } from 'sequelize';
import gina, { DowngradeTarget, MigrationFiles } from './gina';
import { resolveOrder, readVersion, createSnapshot, upgradeFromSnapshot } from './runner';
import { listScripts, loadModule, requireFromProject } from './loader';

interface GinaConfig {
    /** folder with the model files, each one exporting `initializeModel(sequelize)` */
    modelsDir: string;
    /** folder with the migration files */
    migrationsDir: string;
    /** schema snapshot used by `upgrade --from-snapshot` */
    snapshotFile: string;
    /** extra options passed to the Sequelize constructor */
    sequelize?: Options;
}

const LEGACY_INITIALIZE_MODELS = ['initializeModels.ts', 'initializeModels.js'];

async function exists(filePath: string) {
    try {
        await fs.promises.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function readConfig(cwd: string): Promise<GinaConfig> {
    const packageJsonPath = path.join(cwd, 'package.json');
    const packageJson = await exists(packageJsonPath) ? JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8')) : {};
    const config = packageJson.gina ?? {};

    const migrationsDir = path.resolve(cwd, config.migrationsDir ?? 'gina/migrations');
    return {
        modelsDir: path.resolve(cwd, config.modelsDir ?? 'gina/models'),
        migrationsDir,
        snapshotFile: config.snapshotFile ? path.resolve(cwd, config.snapshotFile) : path.join(path.dirname(migrationsDir), 'snapshot.sql'),
        sequelize: config.sequelize,
    };
}

function createSequelize(cwd: string, config: GinaConfig): Sequelize {
    requireFromProject<typeof import('dotenv')>(cwd, 'dotenv').config({ path: path.join(cwd, '.env') });

    const { Sequelize } = requireFromProject<typeof import('sequelize')>(cwd, 'sequelize');

    return new Sequelize({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
        database: process.env.DB_NAME,
        username: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
        dialect: (process.env.DB_DIALECT ?? 'mysql') as Options['dialect'],
        logging: false,
        ...config.sequelize,
    });
}

/**
 * Builds a Sequelize instance with every model of the project loaded.
 * Projects that still have a `gina/initializeModels` file keep using it.
 */
async function initializeModels(cwd: string, config: GinaConfig): Promise<Sequelize> {
    let legacyFile: string | undefined;
    for (const file of LEGACY_INITIALIZE_MODELS) {
        if (await exists(path.join(cwd, 'gina', file))) {
            legacyFile = path.join(cwd, 'gina', file);
            break;
        }
    }

    if (legacyFile) {
        console.info(`loading models using ${path.relative(cwd, legacyFile)}...`);
        const initFile = await loadModule(legacyFile, cwd);
        return (initFile.initializeModels ?? initFile.default.initializeModels)();
    }

    console.info(`loading models from ${path.relative(cwd, config.modelsDir)}...`);
    if (!await exists(config.modelsDir)) {
        throw new Error(`Models folder not found: ${config.modelsDir}. Set "gina.modelsDir" on your package.json.`);
    }

    const sequelize = createSequelize(cwd, config);
    const associations: (() => unknown)[] = [];

    for (const { filePath } of await listScripts(config.modelsDir)) {
        const model = await loadModule(filePath, cwd);
        const initializeModel = model.initializeModel ?? model.default?.initializeModel;
        if (typeof initializeModel !== 'function') {
            console.warn(`skipping ${path.relative(cwd, filePath)}: it doesn't export an initializeModel function.`);
            continue;
        }

        const association = await initializeModel(sequelize);
        if (typeof association === 'function') {
            associations.push(association);
        }
    }

    for (const association of associations) {
        await association();
    }

    return sequelize;
}

async function loadMigrations(cwd: string, config: GinaConfig) {
    const migrations: MigrationFiles = {};

    for (const { name, filePath } of await listScripts(config.migrationsDir)) {
        const file = await loadModule(filePath, cwd);
        const migration = file.migration ?? file.default?.migration ?? file.default;
        if (typeof migration?.up !== 'function') {
            throw new Error(`${path.relative(cwd, filePath)} doesn't export a migration with an up function.`);
        }
        const previous: string | null | undefined = file.previous ?? file.default?.previous ?? migration.previous;
        migrations[name] = { migration, previous, filePath };
    }

    return migrations;
}

/**
 * `HEAD` holds the name of the last migration. Every new migration changes it, so two branches
 * that add migrations at the same time conflict on it instead of merging silently.
 */
function headFile(config: GinaConfig) {
    return path.join(config.migrationsDir, 'HEAD');
}

async function readHead(config: GinaConfig) {
    return await exists(headFile(config)) ? (await fs.promises.readFile(headFile(config), 'utf8')).trim() : undefined;
}

async function writeHead(config: GinaConfig, name: string) {
    await fs.promises.writeFile(headFile(config), `${name}\n`);
}

/**
 * The last migration of the chain. Fails when HEAD names another one, which usually means a
 * merge conflict on HEAD was resolved without fixing the chain.
 */
async function chainHead(config: GinaConfig, migrations: MigrationFiles) {
    const { order } = resolveOrder(migrations);
    const last = order[order.length - 1];
    const head = await readHead(config);
    if (head !== undefined && head !== last) {
        throw new Error(`${path.relative(process.cwd(), headFile(config))} says the last migration is ${head}, but it's ${last}. `
            + 'If you just merged a branch with migrations, make the newer migration run after the other one '
            + '(`export const previous`), then set HEAD to the last migration.');
    }
    return { last, head };
}

async function init(cwd: string) {
    const ginaDir = path.join(cwd, 'gina');
    if (await exists(ginaDir)) {
        console.info('There\'s already a folder/file named gina on your folder indicating that gina is already initialized.');
        return;
    }

    const firstMigration = `${moment().format('YYYYMMDDHHmmss')}-add-version-control-table`;
    await fs.promises.mkdir(path.join(ginaDir, 'migrations'), { recursive: true });
    await fs.promises.writeFile(path.join(ginaDir, 'migrations', 'HEAD'), `${firstMigration}\n`);
    await fs.promises.writeFile(path.join(ginaDir, 'migrations', `${firstMigration}.ts`), `import { QueryInterface, DataTypes } from 'sequelize';

export const migration = {
    async up(queryInterface: QueryInterface) {
        await queryInterface.createTable('gina_version', {
            id: {
                type: DataTypes.INTEGER,
                autoIncrement: true,
                primaryKey: true,
                field: 'id'
            },
            version: {
                type: DataTypes.STRING,
                allowNull: false,
                field: 'version'
            },
            createdAt: {
                type: DataTypes.DATE,
                field: 'createdAt'
            },
            updatedAt: {
                type: DataTypes.DATE,
                field: 'updatedAt'
            },
        });
    },

    async down(queryInterface: QueryInterface) {
        await queryInterface.dropTable('gina_version');
    }
};
`);

    console.info('gina initialized. Point "gina.modelsDir" on your package.json to your models folder, e.g.:');
    console.info(JSON.stringify({ gina: { modelsDir: 'src/database/models' } }, null, 2));
}

async function generateMigration(cwd: string, migrationName: string) {
    const config = await readConfig(cwd);
    const migrations = await loadMigrations(cwd, config);
    const { last } = await chainHead(config, migrations);

    const sequelize = await initializeModels(cwd, config);
    try {
        const version = await readVersion(sequelize);
        if (last && version !== last) {
            throw new Error(`The database is at ${version || 'no version'}, but the last migration is ${last}. `
                + 'Run upgrade first, so the new migration only has the changes that are not in a migration yet.');
        }
        const fileName = await gina.createMigration(sequelize, migrationName, config.migrationsDir, last);
        if (fileName) {
            await writeHead(config, path.parse(fileName).name);
        }
    } finally {
        await sequelize.close();
    }
}

async function upgrade(cwd: string, options: { dryRun?: boolean; fromSnapshot?: boolean; }) {
    const config = await readConfig(cwd);
    const sequelize = await initializeModels(cwd, config);
    try {
        console.info('loading migrations...');
        const migrations = await loadMigrations(cwd, config);
        if (options.dryRun) {
            await gina.dryRunMigrations(sequelize, migrations);
        } else if (options.fromSnapshot) {
            await upgradeFromSnapshot(sequelize, migrations, config.snapshotFile);
        } else {
            await gina.runMigrations(sequelize, migrations, undefined);
        }
    } finally {
        await sequelize.close();
    }
}

async function repair(cwd: string, mode: 'continue' | 'rollback', yes: boolean) {
    const config = await readConfig(cwd);
    const sequelize = await initializeModels(cwd, config);
    try {
        const migrations = await loadMigrations(cwd, config);
        await gina.repairMigration(sequelize, migrations, mode, { yes });
    } finally {
        await sequelize.close();
    }
}

async function check(cwd: string) {
    const config = await readConfig(cwd);
    const migrations = await loadMigrations(cwd, config);
    const { last, head } = await chainHead(config, migrations);
    if (head === undefined) {
        throw new Error(`${path.relative(cwd, headFile(config))} not found. Create it with the last migration: echo ${last} > ${path.relative(cwd, headFile(config))}`);
    }
    console.info(`migrations OK: ${Object.keys(migrations).length} migration(s), the last one is ${last}.`);
}

async function snapshot(cwd: string) {
    const config = await readConfig(cwd);
    const sequelize = await initializeModels(cwd, config);
    try {
        const migrations = await loadMigrations(cwd, config);
        await chainHead(config, migrations);
        await createSnapshot(sequelize, migrations, config.snapshotFile);
    } finally {
        await sequelize.close();
    }
}

async function downgrade(cwd: string, target: DowngradeTarget) {
    const config = await readConfig(cwd);
    const sequelize = await initializeModels(cwd, config);
    try {
        console.info('loading migrations...');
        const migrations = await loadMigrations(cwd, config);
        await gina.revertMigrations(sequelize, migrations, target);
    } finally {
        await sequelize.close();
    }
}

async function run(command: (cwd: string) => Promise<void>) {
    try {
        await command(process.cwd());
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

yargs(hideBin(process.argv))
    .scriptName('gina-cli')
    .command('init', 'creates initial folder and files for gina', () => undefined, () => run(init))
    .command('generate-migration <migration-name>', 'Generates a new migration file to add the differences between models and database', (yargs) => {
        return yargs
            .positional('migration-name', {
                describe: 'Name of the migration to be added',
                type: 'string',
                demandOption: true,
            });
    }, (argv) => run(cwd => generateMigration(cwd, argv['migration-name'])))
    .command('upgrade', 'upgrade database to its last revision', (yargs) => {
        return yargs
            .option('dry-run', {
                describe: 'Apply the pending migrations to a copy of the schema (no data) in a temporary database instead (MySQL/MariaDB)',
                type: 'boolean',
            })
            .option('from-snapshot', {
                describe: 'On an empty database, create the schema from the snapshot and apply only the migrations after it (MySQL/MariaDB)',
                type: 'boolean',
            })
            .conflicts('dry-run', 'from-snapshot');
    }, (argv) => run(cwd => upgrade(cwd, { dryRun: argv['dry-run'], fromSnapshot: argv['from-snapshot'] })))
    .command('downgrade [steps]', 'reverts the last migration, the last N migrations or every migration after --to', (yargs) => {
        return yargs
            .positional('steps', {
                describe: 'How many migrations to revert',
                type: 'number',
            })
            .option('to', {
                describe: 'Migration to go back to, which stays applied (full name or a unique prefix, like its timestamp)',
                type: 'string',
            })
            .conflicts('steps', 'to')
            .example('$0 downgrade', 'reverts the last migration')
            .example('$0 downgrade 3', 'reverts the last 3 migrations')
            .example('$0 downgrade --to 20240531183010', 'reverts every migration after 20240531183010-*');
    }, (argv) => run(cwd => downgrade(cwd, { steps: argv.steps, to: argv.to })))
    .command('repair', 'finishes or undoes a migration that failed halfway', (yargs) => {
        return yargs
            .option('continue', {
                describe: 'Run the failed migration again, skipping what was already applied',
                type: 'boolean',
            })
            .option('rollback', {
                describe: 'Undo what the failed migration applied, skipping what it didn\'t get to',
                type: 'boolean',
            })
            .option('yes', {
                describe: 'Run even if the migration has raw queries or bulk operations, which repair can\'t check and would run again',
                type: 'boolean',
            })
            .conflicts('continue', 'rollback')
            .check(argv => {
                if (!argv.continue && !argv.rollback) {
                    throw new Error('Pass --continue or --rollback.');
                }
                return true;
            });
    }, (argv) => run(cwd => repair(cwd, argv.continue ? 'continue' : 'rollback', Boolean(argv.yes))))
    .command('check', 'checks that the migrations form a single chain and match the HEAD file (for CI)', () => undefined, () => run(check))
    .command('snapshot', 'runs every migration on a temporary database and saves the resulting schema for upgrade --from-snapshot (MySQL/MariaDB)', () => undefined, () => run(snapshot))
    .demandCommand(1)
    .strict()
    .help()
    .parse();
