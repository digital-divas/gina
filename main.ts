import dotenv from 'dotenv';
dotenv.config();

import { Sequelize, Transaction } from 'sequelize';
import path from 'path';
import fs from 'fs/promises';
import gina from './lib/gina';

const modelsDir = path.join(__dirname + `/models`);

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

async function initializeDb() {

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

}

(async () => {
    try {
        await initializeDb();
        await gina.createMigration(sequelize);
        process.exit();
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
})();
