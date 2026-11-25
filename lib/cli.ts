import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import moment from 'moment';
import type { Options, Sequelize } from 'sequelize';
import gina, { DowngradeTarget } from './gina';
import { listScripts, loadModule, requireFromProject } from './loader';
import { MigrationFile } from './typings/migration';

interface GinaConfig {
    /** folder with the model files, each one exporting `initializeModel(sequelize)` */
    modelsDir: string;
    /** folder with the migration files */
    migrationsDir: string;
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

    return {
        modelsDir: path.resolve(cwd, config.modelsDir ?? 'gina/models'),
        migrationsDir: path.resolve(cwd, config.migrationsDir ?? 'gina/migrations'),
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
    const migrations: { [version: string]: { migration: MigrationFile; }; } = {};

    for (const { name, filePath } of await listScripts(config.migrationsDir)) {
        const file = await loadModule(filePath, cwd);
        const migration = file.migration ?? file.default?.migration ?? file.default;
        if (typeof migration?.up !== 'function') {
            throw new Error(`${path.relative(cwd, filePath)} doesn't export a migration with an up function.`);
        }
        migrations[name] = { migration };
    }

    return migrations;
}

async function init(cwd: string) {
    const ginaDir = path.join(cwd, 'gina');
    if (await exists(ginaDir)) {
        console.info('There\'s already a folder/file named gina on your folder indicating that gina is already initialized.');
        return;
    }

    await fs.promises.mkdir(path.join(ginaDir, 'migrations'), { recursive: true });
    await fs.promises.writeFile(path.join(ginaDir, 'migrations', `${moment().format('YYYYMMDDHHmmss')}-add-version-control-table.ts`), `import { QueryInterface, DataTypes } from 'sequelize';

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
    const sequelize = await initializeModels(cwd, config);
    try {
        await gina.createMigration(sequelize, migrationName, config.migrationsDir);
    } finally {
        await sequelize.close();
    }
}

async function upgrade(cwd: string) {
    const config = await readConfig(cwd);
    const sequelize = await initializeModels(cwd, config);
    try {
        console.info('loading migrations...');
        const migrations = await loadMigrations(cwd, config);
        await gina.runMigrations(sequelize, migrations, undefined);
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
    .command('upgrade', 'upgrade database to its last revision', () => undefined, () => run(upgrade))
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
    .demandCommand(1)
    .strict()
    .help()
    .parse();
