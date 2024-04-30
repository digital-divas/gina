import { DataTypes, ModelCtor, Model, Sequelize, ModelAttributeColumnOptions, QueryTypes, ColumnDescription } from 'sequelize';
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
    upForeignKey: string;

    constructor(sequelize: Sequelize) {
        this.upTables = '';
        this.downTables = '';
        this.upFields = '';
        this.downFields = '';
        this.upIndexes = '';
        this.downIndexes = '';
        this.upForeignKey = '';

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
        if (model.type instanceof DataTypes.BOOLEAN) {
            return 'DataTypes.BOOLEAN';
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
        } else if (typeof model.defaultValue == 'boolean') {
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

            if (modelAttrs[modelAttrsKey].references) {
                const references = modelAttrs[modelAttrsKey].references;
                if (typeof references !== 'string') {
                    this.upForeignKey = `
        await queryInterface.addConstraint('${model.getTableName()}', {
            type: 'foreign key',
            fields: ['${modelAttrs[modelAttrsKey].field}'],
            onDelete: '${modelAttrs[modelAttrsKey].onDelete}',
            onUpdate: '${modelAttrs[modelAttrsKey].onUpdate}',
            references: {
                table: '${references?.model}',
                field: '${references?.key}'
            }
        });
`;
                }

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

    columnAttributeProps(attribute: ColumnDescription) {
        if (!this.imports.includes('DataTypes')) {
            this.imports.push('DataTypes');
        }

        let attrProps = '';

        let dataTypes = attribute.type;

        if (dataTypes.includes('VARCHAR(')) {
            dataTypes = dataTypes.replace('VARCHAR(', 'STRING(');
        } else if (dataTypes == 'INT') {
            dataTypes = 'INTEGER';
        }

        attrProps += tabsToSpace(`\n${tabs(3)}type: DataTypes.${dataTypes},`);
        if (attribute.autoIncrement !== null) {
            attrProps += tabsToSpace(`\n${tabs(3)}autoIncrement: ${this.getAutoIncrement(attribute)},`);
        }
        if (attribute.allowNull !== null) {
            attrProps += tabsToSpace(`\n${tabs(3)}allowNull: ${this.getAllowNull(attribute)},`);
        }
        if (attribute.primaryKey !== null) {
            attrProps += tabsToSpace(`\n${tabs(3)}primaryKey: ${this.getPrimaryKey(attribute)},`);
        }
        if (attribute.defaultValue !== null) {
            attrProps += tabsToSpace(`\n${tabs(3)}defaultValue: ${this.getDefaultValue(attribute)},`);
        }

        return attrProps;
    }

    dropColumn(tableName: string, field: string, attribute: ColumnDescription) {
        console.debug(`drop column ${tableName} ${field} `);
        this.upFields += tabsToSpace(`\n\t\tawait queryInterface.removeColumn('${tableName}', '${field}');\n`);
        this.downFields = tabsToSpace(`\n\t\tawait queryInterface.addColumn('${tableName}', '${field}', {${this.columnAttributeProps(attribute)}\n\t\t});`) + this.downFields;
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

                    if (modelAttrs[modelAttr].references) {
                        const references = modelAttrs[modelAttr].references;
                        if (typeof references !== 'string') {
                            this.upForeignKey = `
        await queryInterface.addConstraint('${modelTable}', {
            type: 'foreign key',
            fields: ['${modelAttrs[modelAttr].field}'],
            onDelete: '${modelAttrs[modelAttr].onDelete}',
            onUpdate: '${modelAttrs[modelAttr].onUpdate}',
            references: {
                table: '${references?.model}',
                field: '${references?.key}'
            }
        });
`;
                        }

                    }
                }
            }

            for (const attr of Object.keys(attrs)) {
                if (!modelFields.includes(attr)) {
                    this.dropColumn(modelTable, attr, attrs[attr]);
                }
            }


            const indexes: { name: string; fields: { attribute: string; }[]; unique: boolean; }[] = await queryInterface.showIndex(modelTable) as { name: string; fields: { attribute: string; }[]; unique: boolean; }[];
            const modelIndexes = this.sequelize.models[model].options.indexes;

            if (modelIndexes) {
                for (const modelIndex of modelIndexes) {
                    if (!indexes.find((index) => index.name == modelIndex.name)) {
                        this.upIndexes = `
        await queryInterface.addIndex('${modelTable}', ['${modelIndex.fields?.join('\', \'')}'], {
            name: '${modelIndex.name}',
            unique: ${modelIndex.unique},
        });
`;
                        this.downFields = `
        await queryInterface.removeIndex('${modelTable}', '${modelIndex.name}');
`;
                    }
                }
            }

            if (indexes) {
                for (const index of indexes) {
                    if (index.name === 'PRIMARY') {
                        continue;
                    }
                    if (index.name.endsWith('_fk')) {
                        continue;
                    }
                    if (index.name.includes('_ibfk')) {
                        continue;
                    }

                    if (modelIndexes === undefined || !modelIndexes.find((modelIndex) => index.name == modelIndex.name)) {
                        this.upIndexes = `
        await queryInterface.removeIndex('${modelTable}', '${index.name}');

`;

                        this.downFields = `
        await queryInterface.addIndex('${modelTable}', ['${index.fields?.map(field => field.attribute).join('\', \'')}'], {
            name: '${index.name}',
            unique: ${index.unique},
        });
`;
                    }
                }
            }

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
${this.upForeignKey}
${this.upIndexes}
    },

    async down(queryInterface: QueryInterface) {
${this.downIndexes}
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

    if (!migration.upTables && !migration.upFields && !migration.upIndexes && !migration.upForeignKey) {
        console.info('There\'s no changes between your models and the database.');
    }
    await migration.generateFile(migrationName);

}

const gina = {
    runMigrations,
    createMigration,
};

export default gina;
