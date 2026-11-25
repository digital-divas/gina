/* eslint-disable @typescript-eslint/no-var-requires */
// Small MySQL helper for the e2e runner: node e2e/db.js <create|drop|dump|version|tables|temporary-databases>
const mysql = require('mysql2/promise');

const database = process.env.DB_NAME;

async function main(command) {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
    });

    try {
        if (command === 'create') {
            await connection.query(`DROP DATABASE IF EXISTS \`${database}\``);
            await connection.query(`CREATE DATABASE \`${database}\``);
        } else if (command === 'drop') {
            await connection.query(`DROP DATABASE IF EXISTS \`${database}\``);
        } else if (command === 'version') {
            const [rows] = await connection.query(`SELECT version FROM \`${database}\`.gina_version`);
            console.log(rows.map(row => row.version).join('\n'));
        } else if (command === 'tables') {
            const [rows] = await connection.query('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME', [database]);
            console.log(rows.map(row => row.name).join('\n'));
        } else if (command === 'temporary-databases') {
            const [rows] = await connection.query('SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE \'gina\\_tmp\\_%\'');
            console.log(rows.map(row => row.name).join('\n'));
        } else if (command === 'dump') {
            console.log(JSON.stringify(await dump(connection), null, 2));
        } else {
            throw new Error(`unknown command: ${command}`);
        }
    } finally {
        await connection.end();
    }
}

// Normalized view of the schema, stable across runs so it can be diffed against a snapshot.
async function dump(connection) {
    const [columns] = await connection.query(`
        SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`, [database]);
    const [indexes] = await connection.query(`
        SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME, COLLATION
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`, [database]);
    const [foreignKeys] = await connection.query(`
        SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE
        FROM information_schema.KEY_COLUMN_USAGE k
        JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        WHERE k.TABLE_SCHEMA = ? ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`, [database]);

    const tables = {};
    const table = (name) => (tables[name] ??= { columns: {}, indexes: {}, foreignKeys: {} });

    for (const column of columns) {
        table(column.TABLE_NAME).columns[column.COLUMN_NAME] = [
            column.COLUMN_TYPE,
            column.IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL',
            column.COLUMN_DEFAULT !== null ? `DEFAULT ${column.COLUMN_DEFAULT}` : '',
            column.COLUMN_KEY,
            column.EXTRA,
        ].filter(Boolean).join(' ');
    }

    for (const index of indexes) {
        const indexes = table(index.TABLE_NAME).indexes;
        indexes[index.INDEX_NAME] ??= { unique: index.NON_UNIQUE === 0, columns: [] };
        indexes[index.INDEX_NAME].columns.push(index.COLLATION === 'D' ? `${index.COLUMN_NAME} DESC` : index.COLUMN_NAME);
    }

    for (const fk of foreignKeys) {
        table(fk.TABLE_NAME).foreignKeys[fk.CONSTRAINT_NAME] =
            `${fk.COLUMN_NAME} -> ${fk.REFERENCED_TABLE_NAME}.${fk.REFERENCED_COLUMN_NAME} ON UPDATE ${fk.UPDATE_RULE} ON DELETE ${fk.DELETE_RULE}`;
    }

    return tables;
}

main(process.argv[2]).catch((err) => {
    console.error(err);
    process.exit(1);
});
