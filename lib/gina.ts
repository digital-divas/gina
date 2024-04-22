import { DataTypes, ModelCtor, Model, Sequelize, ModelAttributeColumnOptions, QueryTypes } from 'sequelize';
import fs from 'fs/promises';
import moment from 'moment';
import { MigrationFile } from './typings/migration';

interface MigrationFiles {
    [version: string]: { migration: MigrationFile; };
}

async function runMigrations(sequelize: Sequelize, migrationFiles: MigrationFiles) {
    const tables = await sequelize.getQueryInterface().showAllTables();

    let version = '';

    if (tables.includes('gina_version')) {
        const versions: { version: string; }[] = await sequelize.query('SELECT version FROM gina_version;', {
            type: QueryTypes.SELECT,
        });

        if (versions.length > 1) {
            throw new Error('There must be only one version on `gina_version` table.');
        }

        version = versions.length == 1 ? versions[0].version : '';
    }

    console.info('current version:', version);

    for (const migrationFile of Object.keys(migrationFiles)) {
        if (migrationFile > version) {
            console.info('applying migration:', migrationFile);
            await migrationFiles[migrationFile].migration.up(sequelize.getQueryInterface());
            if (version) {
                version = migrationFile;
                await sequelize.query(`UPDATE gina_version SET version = '${version}', updatedAt = NOW();`);
            } else {
                version = migrationFile;
                await sequelize.query(`INSERT INTO gina_version (updatedAt, version) VALUES (NOW(),'${version}');`);
            }
            console.info('applied version:', migrationFile);
        }
    }
}

function tabsToSpace(str: string) {
    return str.replaceAll('\t', '    ');
}

function tabs(qty: number) {
    let tabText = '';

    for (let i = 0; i < qty; i++) {
        tabText += '\t';
    }

    return tabText;
}

class Migration {
    upTables: string;
    downTables: string;
    upFields: string;
    downFields: string;
    upIndexes: string;
    downIndexes: string;
    private sequelize: Sequelize;
    tables: string[];
    imports: string[];

    constructor(sequelize: Sequelize) {
        this.upTables = '';
        this.downTables = '';
        this.upFields = '';
        this.downFields = '';
        this.upIndexes = '';
        this.downIndexes = '';

        /**
         *
         */
        this.tables = [];
        this.sequelize = sequelize;
        this.imports = ['QueryInterface'];
    }

    async loadDatabaseTables() {
        const queryInterface = this.sequelize.getQueryInterface();
        this.tables = await queryInterface.showAllTables();
    }

    dropTable(tableName: string) {
        // TODO: create proper logic to delete table
        console.debug(`drop table ${tableName} `);

        this.upTables += `
        await queryInterface.dropTable('${tableName}');
`;

        this.downTables = `
        await queryInterface.createTable('${tableName}', {});
` + this.downTables;
    }

    getAllowNull(model: { allowNull?: boolean; }) {
        return model.allowNull ?? 'true' ? 'true' : 'false';
    }

    getAutoIncrement(model: { autoIncrement?: boolean; }) {
        return model.autoIncrement ?? 'true' ? 'true' : 'false';
    }

    getPrimaryKey(model: { primaryKey?: boolean; }) {
        return model.primaryKey ?? 'true' ? 'true' : 'false';
    }

    getType(model: { type?: DataTypes.DataType; }) {
        if (model.type instanceof DataTypes.BIGINT) {
            return 'DataTypes.BIGINT';
        }
        if (model.type instanceof DataTypes.INTEGER) {
            return 'DataTypes.INTEGER';
        }
        if (model.type instanceof DataTypes.STRING) {
            return 'DataTypes.STRING';
        }
        if (model.type instanceof DataTypes.DATE) {
            return 'DataTypes.DATE';
        }
        if (model.type instanceof DataTypes.TEXT) {
            return 'DataTypes.TEXT';
        }
        return '';
    }

    getDefaultValue(model: { defaultValue?: unknown; }) {

        const val = (model.defaultValue as { val?: string; }).val;

        if (val) {
            if (!this.imports.includes('Sequelize')) {
                this.imports.push('Sequelize');
            }
            return `Sequelize.literal('${val}')`;
        } else if (typeof model.defaultValue == 'number') {
            return String(model.defaultValue);
        }

        return `'${model.defaultValue}'`;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createTable(model: ModelCtor<Model<any, any>>) {
        // TODO: create proper logic to create table
        console.debug(`new table ${model.getTableName()}`);
        const modelAttrs = model.getAttributes();
        const modelAttrsKeys = Object.keys(modelAttrs);
        this.upTables += tabsToSpace(`\n\t\tawait queryInterface.createTable('${model.getTableName()}', {\n`);

        if (!this.imports.includes('DataTypes')) {
            this.imports.push('DataTypes');
        }

        for (const modelAttrsKey of modelAttrsKeys) {

            const attribute = modelAttrs[modelAttrsKey];

            if (attribute.type instanceof DataTypes.VIRTUAL) {
                continue;
            }

            this.upTables += tabsToSpace(`\t\t\t${modelAttrsKey}: {${this.attributeProps(modelAttrs[modelAttrsKey], 4)}\n\t\t\t},\n`);
        }

        this.upTables += tabsToSpace(`\t\t});`);

        this.downTables = tabsToSpace(`\n\t\tawait queryInterface.dropTable('${model.getTableName()}');\n`) + this.downTables;
    }


    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attributeProps(attribute: ModelAttributeColumnOptions<Model<any, any>>, tabsQty: number) {

        if (!this.imports.includes('DataTypes')) {
            this.imports.push('DataTypes');
        }

        let attrProps = '';

        attrProps += tabsToSpace(`\n${tabs(tabsQty)}type: ${this.getType(attribute)},`);
        if (attribute.autoIncrement !== undefined) {
            attrProps += tabsToSpace(`\n${tabs(tabsQty)}autoIncrement: ${this.getAutoIncrement(attribute)},`);
        }
        if (attribute.allowNull !== undefined) {
            attrProps += tabsToSpace(`\n${tabs(tabsQty)}allowNull: ${this.getAllowNull(attribute)},`);
        }
        if (attribute.primaryKey !== undefined) {
            attrProps += tabsToSpace(`\n${tabs(tabsQty)}primaryKey: ${this.getPrimaryKey(attribute)},`);
        }
        if (attribute.defaultValue !== undefined) {
            attrProps += tabsToSpace(`\n${tabs(tabsQty)}defaultValue: ${this.getDefaultValue(attribute)},`);
        }

        attrProps += tabsToSpace(`\n${tabs(tabsQty)}field: '${attribute.field}'`);

        return attrProps;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    newColumn(tableName: string, attribute: ModelAttributeColumnOptions<Model<any, any>>) {
        console.debug(`new column ${tableName} ${attribute.field}`);
        this.upFields += tabsToSpace(`\n\t\tawait queryInterface.addColumn('${tableName}', '${attribute.field}', {${this.attributeProps(attribute, 3)}\n\t\t});\n`);
        this.downFields = tabsToSpace(`\n\t\tawait queryInterface.removeColumn('${tableName}', '${attribute.field}');\n`) + this.downFields;
    }

    async checkDiffs() {
        const models = Object.keys(this.sequelize.models);
        const modelTableNames: string[] = [];
        for (const model of models) {

            const modelTable = this.sequelize.models[model].getTableName() as string;
            modelTableNames.push(modelTable);

            // new table
            if (!this.tables.includes(modelTable)) {
                this.createTable(this.sequelize.models[model]);
                continue;
            }

            const modelAttrs = this.sequelize.models[model].getAttributes();
            const queryInterface = this.sequelize.getQueryInterface();
            const attrs = await queryInterface.describeTable(modelTable);

            const modelFields: string[] = [];

            // check each field
            for (const modelAttr of Object.keys(modelAttrs)) {
                modelFields.push(modelAttrs[modelAttr].field || modelAttr);
                if (!Object.keys(attrs).includes(modelAttrs[modelAttr].field || modelAttr) && !(modelAttrs[modelAttr].type instanceof DataTypes.VIRTUAL)) {
                    this.newColumn(modelTable, modelAttrs[modelAttr]);
                }
            }

            for (const attr of Object.keys(attrs)) {
                if (!modelFields.includes(attr)) {
                    console.debug(`drop column ${modelTable} ${attr} `);

                    this.upFields += `;
                await queryInterface.removeColumn('${modelTable}', '${attr}');
                `;

                    if (!this.imports.includes('DataTypes')) {
                        this.imports.push('DataTypes');
                    }

                    this.downFields = `;
                await queryInterface.addColumn('${modelTable}', '${attr}', {
                    type: DataTypes.${attrs[attr].type.replace('VARCHAR(', 'STRING(')},
                    allowNull: ${this.getAllowNull(attrs[attr])},
                    defaultValue: ${attrs[attr].defaultValue},
            });
            ` + this.downFields;
                }
            }

            // TODO: add index and constraints
            // sequelize.models[model].
            // console.debug('sequelize.models.GinaVersion.options.indexes', sequelize.models.GinaVersion.options.indexes);
            // console.log(sequelize.models[model]);

        }

        for (const table of this.tables) {
            if (!modelTableNames.includes(table) && table != 'gina_version') {
                this.dropTable(table);
            }
        }
    }

    async generateFile(migrationName: string) {
        const migration = `import { ${this.imports.join(', ')} } from 'sequelize';

export const migration = {
    async up(queryInterface: QueryInterface) {
${this.upTables}
${this.upFields}
    },

    async down(queryInterface: QueryInterface) {
${this.downFields}
${this.downTables}
    }
};`;

        await fs.writeFile(`./gina/migrations/${moment().format('YYYYMMDDHHmmss')}-${migrationName.toLowerCase().replaceAll(' ', '-')}.ts`, migration);
    }
}

async function createMigration(sequelize: Sequelize, migrationName: string) {

    const migration = new Migration(sequelize);
    await migration.loadDatabaseTables();

    await migration.checkDiffs();

    if (!migration.upTables && !migration.upFields && !migration.upIndexes) {
        console.info('There\'s no changes between your models and the database.');
        return;
    }
    await migration.generateFile(migrationName);

}

const gina = {
    runMigrations,
    createMigration,
};

export default gina;
