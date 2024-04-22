#! /usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const fs = require('fs/promises');
const moment = require('moment');

async function createInitialFolder() {
    const files = await fs.readdir('.');
    if (files.includes('gina')) {
        console.info('There\'s already a folder/file named gina on your folder indicating that gina is already initialized.');
        return;
    }



    await fs.mkdir('gina');
    await fs.mkdir('gina/migrations');
    await fs.writeFile(`gina/migrations/${moment().format('YYYYMMDDHHmmss') + '-add-version-control-table.ts'}`, `import { QueryInterface, DataTypes } from 'sequelize';

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

    await fs.writeFile('gina/initializeModels.ts', `import dotenv from 'dotenv';
dotenv.config();

import { Sequelize, Transaction } from 'sequelize';
import path from 'path';
import fs from 'fs/promises';

const modelsDir = path.join(__dirname + '/models');

const POOL_MAX_CONNECTIONS = 50;
const POOL_IDLE_TIME = 12000;
const POOL_ACQUIRE_TIME = 30000;

const sequelize = new Sequelize({
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    dialect: 'mysql',
    isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED,
    pool: {
        max: POOL_MAX_CONNECTIONS,
        min: 0,
        idle: POOL_IDLE_TIME,
        evict: POOL_IDLE_TIME - 2000,
        acquire: POOL_ACQUIRE_TIME
    },
    logging: console.info
});

async function initializeModels() {

    const files = (await fs.readdir(modelsDir)).filter(file => !file.includes('.d.ts') && !file.includes('.js.map'));
    const associations: (() => void)[] = [];

    for (const file of files) {
        const filePath = path.join(modelsDir, file);
        const model = await import(filePath.replace('.js', ''));
        associations.push(model.initializeModel(sequelize));
    }

    for (const association of associations) {
        association();
    }

    return sequelize;
}


export { initializeModels };
`);

    await fs.writeFile('gina/upgrade.ts', `
import { initializeModels } from './initializeModels';
import gina from 'gina-sequelize';

(async () => {
    try {
        const sequelize = await initializeModels();
        await gina.runMigrations(sequelize);
        process.exit();
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
})();
`);

    await fs.writeFile('gina/generate-migration.ts', `
import { initializeModels } from './initializeModels';
import gina from 'gina-sequelize';

(async () => {
    try {
        const sequelize = await initializeModels();
        await gina.createMigration(sequelize);
        process.exit();
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
})();
`);

}

yargs(hideBin(process.argv))
    .command('init', 'creates initial folder and files for gina', () => {
        createInitialFolder();
    })
    .command('generate-migration [migration-name]', 'Generates a new migration file to add the differences between models and database', (yargs) => {
        return yargs
            .positional('migration-name', {
                describe: 'Name of the migration to be added'
            });
    }, (argv) => {
        console.info(`start server on :${argv['migration-name']}`);
    })
    .command('upgrade', 'upgrade database to its last revision', () => {
        console.log('upgrade');
    })
    .parse();
