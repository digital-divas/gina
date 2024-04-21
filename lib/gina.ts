import dotenv from 'dotenv';
dotenv.config();

import { DataTypes, Sequelize } from 'sequelize';
import fs from 'fs/promises';
import moment from 'moment';

function runMigrations() {
    return;
}

async function createMigration(sequelize: Sequelize) {
    const models = Object.keys(sequelize.models);
    const queryInterface = sequelize.getQueryInterface();
    const tables = await queryInterface.showAllTables();

    const modelTables: string[] = [];

    let upTables = '';
    let downTables = '';
    let up = '';
    let down = '';
    const imports = ['QueryInterface'];

    for (const model of models) {
        const modelTable = sequelize.models[model].getTableName() as string;
        modelTables.push(modelTable);
        if (!tables.includes(modelTable)) {
            // TODO: create proper logic to create table
            console.debug(`new table ${modelTable}`);
            // console.debug('sequelize.models[model].getAttributes()', sequelize.models[model].getAttributes());
            upTables += `
        await queryInterface.createTable('${modelTable}', {});
`;

            downTables = `
        await queryInterface.dropTable('${modelTable}');
` + downTables;
            continue;
        }

        const modelAttrs = sequelize.models[model].getAttributes();
        const attrs = await queryInterface.describeTable(modelTable);

        const modelFields: string[] = [];

        for (const modelAttr of Object.keys(modelAttrs)) {
            modelFields.push(modelAttrs[modelAttr].field || modelAttr);
            if (!Object.keys(attrs).includes(modelAttrs[modelAttr].field || modelAttr) && !(modelAttrs[modelAttr].type instanceof DataTypes.VIRTUAL)) {

                console.debug(`new column ${modelTable} ${modelAttr}`);
                // console.debug(modelAttrs[modelAttr]);

                const val = (modelAttrs[modelAttr].defaultValue as { val?: string; }).val;
                let defaultValue: string;

                if (val) {
                    if (!imports.includes('Sequelize')) {
                        imports.push('Sequelize');
                    }
                    defaultValue = 'Sequelize.literal(\'CURRENT_TIMESTAMP\')';
                } else {
                    defaultValue = modelAttrs[modelAttr].defaultValue as string;
                }

                if (!imports.includes('DataTypes')) {
                    imports.push('DataTypes');
                }

                up += `
        await queryInterface.addColumn('${modelTable}', '${modelAttrs[modelAttr].field}', {
            type: DataTypes.${modelAttrs[modelAttr].type instanceof DataTypes.DATE ? 'DATE' : ''},
            allowNull: ${modelAttrs[modelAttr].allowNull},
            defaultValue: ${defaultValue}
        });
`;

                down = `
        await queryInterface.removeColumn('${modelTable}', '${modelAttrs[modelAttr].field}');
` + down;

            }
        }

        for (const attr of Object.keys(attrs)) {
            if (!modelFields.includes(attr)) {
                console.debug(`drop column ${modelTable} ${attr}`);

                up += `
        await queryInterface.removeColumn('${modelTable}', '${attr}');
`;

                if (!imports.includes('DataTypes')) {
                    imports.push('DataTypes');
                }

                down = `
        await queryInterface.addColumn('${modelTable}', '${attr}', {
            type: DataTypes.${attrs[attr].type.replace('VARCHAR(', 'STRING(')},
            allowNull: ${attrs[attr].allowNull ? 'true' : 'false'},
            defaultValue: ${attrs[attr].defaultValue},
        });
` + down;
            }
        }

        // TODO: add index and constraints
        // sequelize.models[model].
        // console.debug('sequelize.models.GinaVersion.options.indexes', sequelize.models.GinaVersion.options.indexes);
        // console.log(sequelize.models[model]);

    }

    for (const table of tables) {
        if (!modelTables.includes(table)) {
            // TODO: create proper logic to delete table
            console.debug(`drop table ${table} `);
            upTables += `
        await queryInterface.dropTable('${table}');
`;

            downTables = `
        await queryInterface.createTable('${table}', {});
` + downTables;
        }
    }

    const migration = `import { ${imports.join(', ')} } from 'sequelize';

export const migration: Migration = {
    async up(queryInterface: QueryInterface) {
${upTables}
${up}
    },

    async down(queryInterface: QueryInterface) {
${down}
${downTables}
    }
};`;


    await fs.writeFile('./migrations/' + moment().format('YYYYMMDDHHmmss') + '.ts', migration);


}

const gina = {
    runMigrations,
    createMigration,
};

export default gina;
