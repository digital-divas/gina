import { ModelCtor, Model, Sequelize, ModelAttributeColumnOptions, QueryTypes } from 'sequelize';
import { runMigrations, revertMigrations, repairMigration, dryRunMigrations, DowngradeTarget, MigrationFiles } from './runner';
import fs from 'fs/promises';
import path from 'path';
import moment from 'moment';
import {
    DatabaseColumn,
    ModelDataType,
    quote,
    modelTypeToCode,
    normalizeColumnType,
    modelDefaultToSql,
    sameDefault,
    databaseTypeToCode,
    databaseDefaultToCode,
} from './column-types';

/**
 * Index fields can be plain column names or objects like `{ name: 'time', order: 'DESC' }`.
 */
function formatIndexFields(fields: unknown[] | undefined) {
    const formatted = (fields ?? []).map((field) => {
        if (typeof field === 'string') {
            return `'${field}'`;
        }
        const { name, order, length, collate } = field as { name: string; order?: string; length?: number; collate?: string; };
        const props = [`name: '${name}'`];
        if (order) {
            props.push(`order: '${order}'`);
        }
        if (length) {
            props.push(`length: ${length}`);
        }
        if (collate) {
            props.push(`collate: '${collate}'`);
        }
        return `{ ${props.join(', ')} }`;
    });
    return `[${formatted.join(', ')}]`;
}

function isVirtual(attribute: { type?: unknown; }) {
    return (attribute.type as ModelDataType | undefined)?.key === 'VIRTUAL';
}

/**
 * Sequelize columns are nullable unless `allowNull: false`, and primary keys never are.
 */
function isNullable(attribute: { allowNull?: boolean; primaryKey?: boolean; }) {
    return attribute.allowNull !== false && !attribute.primaryKey;
}

interface ModelIndex {
    name?: string;
    fields?: unknown[];
    unique?: boolean;
    /** declared with `unique` on the attribute: matched by its columns, since the index name is up to the database */
    fromAttribute?: boolean;
}

/**
 * The model's indexes: `options.indexes` plus the unique indexes declared on attributes
 * (`unique: true`, or `unique: 'name'` shared by the attributes of a composite index).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function modelIndexesOf(model: ModelCtor<Model<any, any>>, tableName: string): ModelIndex[] {
    const indexes: ModelIndex[] = [...(model.options.indexes ?? []) as ModelIndex[]];
    const composite = new Map<string, string[]>();

    for (const attribute of Object.values(model.getAttributes())) {
        const unique = (attribute as { unique?: boolean | string | { name?: string; }; }).unique;
        const field = attribute.field as string;
        if (!unique || isVirtual(attribute)) {
            continue;
        }
        const name = typeof unique === 'string' ? unique : typeof unique === 'object' ? unique.name : undefined;
        if (name) {
            composite.set(name, [...composite.get(name) ?? [], field]);
        } else {
            indexes.push({ name: `${tableName}_${field}_unique`, fields: [field], unique: true, fromAttribute: true });
        }
    }
    for (const [name, fields] of composite) {
        indexes.push({ name, fields, unique: true, fromAttribute: true });
    }

    return indexes;
}

function indexColumns(fields: unknown[] | undefined) {
    return (fields ?? []).map(field => (typeof field === 'string' ? field : (field as { name?: string; attribute?: string; }).name ?? (field as { attribute: string; }).attribute));
}

/** Whether a database index is the one the model declares: by name, or by its columns for attribute-level unique indexes. */
function sameIndex(modelIndex: ModelIndex, index: { name: string; fields?: { attribute: string; }[]; unique: boolean; }) {
    if (modelIndex.name === index.name) {
        return true;
    }
    return Boolean(modelIndex.fromAttribute && index.unique
        && indexColumns(modelIndex.fields).join(',') === indexColumns(index.fields).join(','));
}

/** MySQL can't store a default value for these types (and Sequelize drops the plain TEXT one): the model's default only applies on create. */
const TYPES_WITHOUT_DEFAULT = ['TEXT', 'BLOB', 'JSON', 'GEOMETRY'];

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
    /** columns dropped on up, added back on down in table order so each one can go after the previous */
    downDroppedFields: string;
    upIndexes: string;
    downIndexes: string;
    private sequelize: Sequelize;
    tables: string[];
    imports: string[];
    upForeignKey: string;
    /** foreign keys added on up are removed first on down, before their tables or columns */
    downForeignKey: string;

    constructor(sequelize: Sequelize) {
        this.upTables = '';
        this.downTables = '';
        this.upFields = '';
        this.downFields = '';
        this.downDroppedFields = '';
        this.upIndexes = '';
        this.downIndexes = '';
        this.upForeignKey = '';
        this.downForeignKey = '';

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

    getType(model: { type?: unknown; }) {
        return modelTypeToCode(model.type as ModelDataType);
    }

    useSequelize() {
        if (!this.imports.includes('Sequelize')) {
            this.imports.push('Sequelize');
        }
    }

    getDefaultValue(model: { defaultValue?: unknown; }) {
        const defaultValue = model.defaultValue;

        if (defaultValue === null) {
            return 'null';
        } else if (typeof defaultValue == 'object' && 'val' in defaultValue) {
            this.useSequelize();
            return `Sequelize.literal(${quote(String((defaultValue as { val: unknown; }).val))})`;
        } else if (typeof defaultValue == 'number' || typeof defaultValue == 'boolean') {
            return String(defaultValue);
        }

        return quote(String(defaultValue));
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

            if (isVirtual(attribute)) {
                continue;
            }

            if (modelAttrs[modelAttrsKey].references) {
                const references = modelAttrs[modelAttrsKey].references;
                if (typeof references !== 'string') {
                    this.foreignKey(model.getTableName() as string, modelAttrs[modelAttrsKey].field as string, references, modelAttrs[modelAttrsKey]);
                }

            }

            this.upTables += tabsToSpace(`\t\t\t${modelAttrsKey}: {${this.attributeProps(modelAttrs[modelAttrsKey], 4)}\n\t\t\t},\n`);

        }

        const modelIndexes = modelIndexesOf(model, model.getTableName() as string);

        if (modelIndexes.length) {
            for (const modelIndex of modelIndexes) {
                this.upIndexes += `
        await queryInterface.addIndex('${model.getTableName()}', {
            fields: ${formatIndexFields(modelIndex.fields)},
            name: '${modelIndex.name}',
            unique: ${modelIndex.unique},
        });
`;
                // no removeIndex on down: dropTable removes the table's indexes, and MySQL
                // refuses to remove an index a foreign key needs
            }
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
        if (this.hasDatabaseDefault(attribute)) {
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

    /**
     * Props that recreate a column as it currently is in the database.
     */
    columnAttributeProps(column: DatabaseColumn, tabsQty: number) {
        if (!this.imports.includes('DataTypes')) {
            this.imports.push('DataTypes');
        }

        let attrProps = tabsToSpace(`\n${tabs(tabsQty)}type: ${databaseTypeToCode(column.type)},`);
        if (column.autoIncrement) {
            attrProps += tabsToSpace(`\n${tabs(tabsQty)}autoIncrement: true,`);
        }
        attrProps += tabsToSpace(`\n${tabs(tabsQty)}allowNull: ${column.allowNull},`);
        if (column.defaultValue !== null) {
            const { code, needsSequelize } = databaseDefaultToCode(column.defaultValue, column.type);
            if (needsSequelize) {
                this.useSequelize();
            }
            attrProps += tabsToSpace(`\n${tabs(tabsQty)}defaultValue: ${code},`);
        }

        return attrProps;
    }

    /**
     * Props for `changeColumn` with the model's definition. Primary keys and references are left out:
     * MySQL would try to add them again.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    changedAttributeProps(attribute: ModelAttributeColumnOptions<Model<any, any>>, tabsQty: number) {
        let attrProps = tabsToSpace(`\n${tabs(tabsQty)}type: ${this.getType(attribute)},`);
        if (attribute.autoIncrement) {
            attrProps += tabsToSpace(`\n${tabs(tabsQty)}autoIncrement: true,`);
        }
        attrProps += tabsToSpace(`\n${tabs(tabsQty)}allowNull: ${isNullable(attribute)},`);
        if (this.hasDatabaseDefault(attribute)) {
            attrProps += tabsToSpace(`\n${tabs(tabsQty)}defaultValue: ${this.getDefaultValue(attribute)},`);
        }
        return attrProps;
    }

    /**
     * The constraint gets an explicit name (the one Sequelize would pick) so down can remove it.
     */
    foreignKey(tableName: string, field: string, references: { model?: unknown; key?: string; }, attribute: { onDelete?: string; onUpdate?: string; }) {
        const name = `${tableName}_${field}_${references.model}_fk`;
        this.upForeignKey += `
        await queryInterface.addConstraint('${tableName}', {
            type: 'foreign key',
            name: '${name}',
            fields: ['${field}'],
            onDelete: '${attribute.onDelete}',
            onUpdate: '${attribute.onUpdate}',
            references: {
                table: '${references.model}',
                field: '${references.key}'
            }
        });
`;
        this.downForeignKey = `
        await queryInterface.removeConstraint('${tableName}', '${name}');
` + this.downForeignKey;
    }

    /**
     * @param after the column before it in the table, so down adds it back at the same position (MySQL/MariaDB)
     */
    dropColumn(tableName: string, field: string, column: DatabaseColumn, after: string | undefined) {
        console.debug(`drop column ${tableName} ${field} `);
        let position = '';
        let cast = '';
        if (this.supportsColumnChanges) {
            // after/first work on MySQL but are missing from Sequelize's types
            position = tabsToSpace(after ? `\n\t\t\tafter: ${quote(after)},` : '\n\t\t\tfirst: true,');
            cast = ' as ModelAttributeColumnOptions';
            if (!this.imports.includes('ModelAttributeColumnOptions')) {
                this.imports.push('ModelAttributeColumnOptions');
            }
        }
        this.upFields += tabsToSpace(`\n\t\tawait queryInterface.removeColumn('${tableName}', '${field}');\n`);
        this.downDroppedFields += tabsToSpace(`\n\t\tawait queryInterface.addColumn('${tableName}', '${field}', {${this.columnAttributeProps(column, 3)}${position}\n\t\t}${cast});\n`);
    }

    /**
     * Compares a model attribute with its column and returns what changed (type, nullability, default).
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    columnChanges(attribute: ModelAttributeColumnOptions<Model<any, any>>, column: DatabaseColumn) {
        const changes: string[] = [];

        const modelType = normalizeColumnType((attribute.type as ModelDataType).toSql({ escape: (value) => this.sequelize.escape(value as string) }));
        const databaseType = normalizeColumnType(column.type);
        if (modelType !== databaseType) {
            changes.push(`type ${databaseType} -> ${modelType}`);
        }

        if (isNullable(attribute) !== column.allowNull) {
            changes.push(`allowNull ${column.allowNull} -> ${isNullable(attribute)}`);
        }

        const modelDefault = modelDefaultToSql(attribute.defaultValue);
        if (this.hasDatabaseDefault(attribute) && modelDefault !== undefined && !sameDefault(modelDefault, column.defaultValue)) {
            changes.push(`default ${column.defaultValue} -> ${modelDefault}`);
        }

        return changes;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    changeColumn(tableName: string, attribute: ModelAttributeColumnOptions<Model<any, any>>, column: DatabaseColumn, changes: string[]) {
        console.debug(`change column ${tableName} ${attribute.field}: ${changes.join(', ')}`);
        this.upFields += tabsToSpace(`\n\t\tawait queryInterface.changeColumn('${tableName}', '${attribute.field}', {${this.changedAttributeProps(attribute, 3)}\n\t\t});\n`);
        this.downFields = tabsToSpace(`\n\t\tawait queryInterface.changeColumn('${tableName}', '${attribute.field}', {${this.columnAttributeProps(column, 3)}\n\t\t});\n`) + this.downFields;
    }

    /**
     * Whether the attribute's default can be stored by the database. Defaults of functions (e.g. NOW)
     * and, on MySQL/MariaDB, of TEXT, BLOB, JSON and GEOMETRY columns only apply when Sequelize creates a row.
     */
    hasDatabaseDefault(attribute: { type?: unknown; defaultValue?: unknown; }) {
        if (attribute.defaultValue === undefined || modelDefaultToSql(attribute.defaultValue) === undefined) {
            return false;
        }
        const key = (attribute.type as ModelDataType | undefined)?.key;
        return !(this.supportsColumnChanges && key !== undefined && TYPES_WITHOUT_DEFAULT.includes(key));
    }

    get supportsColumnChanges() {
        return ['mysql', 'mariadb'].includes(this.sequelize.getDialect());
    }

    /**
     * Reads the table's columns. On MySQL/MariaDB it uses information_schema, which keeps
     * the full column type (e.g. enum values with their original case); other dialects use describeTable.
     */
    async describeColumns(tableName: string): Promise<{ [column: string]: DatabaseColumn; }> {
        const columns: { [column: string]: DatabaseColumn; } = {};

        if (this.supportsColumnChanges) {
            const rows: { name: string; type: string; nullable: string; defaultValue: string | null; extra: string; columnKey: string; }[] = await this.sequelize.query(`
                SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS defaultValue, EXTRA AS extra, COLUMN_KEY AS columnKey
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :tableName
                ORDER BY ORDINAL_POSITION`, {
                type: QueryTypes.SELECT,
                replacements: { tableName },
            });

            for (const row of rows) {
                columns[row.name] = {
                    type: row.type,
                    allowNull: row.nullable === 'YES',
                    defaultValue: row.defaultValue,
                    autoIncrement: row.extra.includes('auto_increment'),
                    primaryKey: row.columnKey === 'PRI',
                };
            }
            return columns;
        }

        const description = await this.sequelize.getQueryInterface().describeTable(tableName);
        for (const [name, column] of Object.entries(description)) {
            columns[name] = {
                type: column.type,
                allowNull: column.allowNull,
                defaultValue: column.defaultValue as string | null,
                autoIncrement: Boolean(column.autoIncrement),
                primaryKey: column.primaryKey,
            };
        }
        return columns;
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
            const attrs = await this.describeColumns(modelTable);

            const modelFields: string[] = [];

            const modelRefs: string[] = [];

            for (const modelAttr of Object.keys(modelAttrs)) {
                if (modelAttrs[modelAttr].references) {
                    modelRefs.push(modelAttrs[modelAttr].field || '');
                }
            }

            // check each field
            for (const modelAttr of Object.keys(modelAttrs)) {
                modelFields.push(modelAttrs[modelAttr].field || modelAttr);
                const column = attrs[modelAttrs[modelAttr].field || modelAttr];
                if (column && !isVirtual(modelAttrs[modelAttr]) && this.supportsColumnChanges) {
                    const changes = this.columnChanges(modelAttrs[modelAttr], column);
                    if (changes.length) {
                        this.changeColumn(modelTable, modelAttrs[modelAttr], column, changes);
                    }
                }
                if (!column && !isVirtual(modelAttrs[modelAttr])) {
                    this.newColumn(modelTable, modelAttrs[modelAttr]);
                    if (modelAttrs[modelAttr].references) {
                        const references = modelAttrs[modelAttr].references;
                        if (typeof references !== 'string') {
                            this.foreignKey(modelTable, modelAttrs[modelAttr].field as string, references, modelAttrs[modelAttr]);
                        }

                    }
                }
            }

            // drop column
            const columnNames = Object.keys(attrs);
            columnNames.forEach((attr, index) => {
                if (!modelFields.includes(attr)) {
                    this.dropColumn(modelTable, attr, attrs[attr], columnNames[index - 1]);
                }
            });


            const indexes: { name: string; fields: { attribute: string; }[]; unique: boolean; }[] = await queryInterface.showIndex(modelTable) as { name: string; fields: { attribute: string; }[]; unique: boolean; }[];
            const modelIndexes = modelIndexesOf(this.sequelize.models[model], modelTable);

            if (modelIndexes.length) {
                for (const modelIndex of modelIndexes) {
                    if (!indexes.find((index) => sameIndex(modelIndex, index))) {
                        this.upIndexes += `
        await queryInterface.addIndex('${modelTable}', {
            fields: ${formatIndexFields(modelIndex.fields)},
            name: '${modelIndex.name}',
            unique: ${modelIndex.unique},
        });
`;
                        this.downIndexes = `
        await queryInterface.removeIndex('${modelTable}', '${modelIndex.name}');
` + this.downIndexes;
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
                    // this may be necessary only for databases previously created with sequelize.sync
                    if (index.name.includes('_ibfk')) {
                        continue;
                    }
                    // this may be necessary only for databases previously created with sequelize.sync
                    if (modelRefs.includes(index.name)) {
                        continue;
                    }

                    if (!modelIndexes.find((modelIndex) => sameIndex(modelIndex, index))) {
                        this.upIndexes += `
        await queryInterface.removeIndex('${modelTable}', '${index.name}');

`;

                        this.downIndexes = `
        await queryInterface.addIndex('${modelTable}', ['${index.fields?.map(field => field.attribute).join('\', \'')}'], {
            name: '${index.name}',
            unique: ${index.unique},
        });
` + this.downIndexes;
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

    async generateFile(migrationName: string, migrationsDir: string, previous?: string) {
        const migration = `import { ${this.imports.join(', ')} } from 'sequelize';
${previous ? `\n// runs after this migration (see "Migration order" on gina's README)\nexport const previous = ${quote(previous)};\n` : ''}
export const migration = {
    async up(queryInterface: QueryInterface) {
${this.upTables}
${this.upFields}
${this.upForeignKey}
${this.upIndexes}
    },

    async down(queryInterface: QueryInterface) {
${this.downForeignKey}
${this.downIndexes}
${this.downFields}
${this.downDroppedFields}
${this.downTables}
    }
};`;

        const fileName = `${moment().format('YYYYMMDDHHmmss')}-${migrationName.toLowerCase().replaceAll(' ', '-')}.ts`;
        await fs.writeFile(path.join(migrationsDir, fileName), tidy(migration));
        console.info('migration created:', path.join(migrationsDir, fileName));
        return fileName;
    }
}

/**
 * The sections of a generated migration are joined with blank lines, and some of them are empty:
 * no blank lines right after `{` or before `}`, at most one in a row, and a newline at the end.
 */
function tidy(code: string) {
    return `${code
        .replace(/\{\n(?:[ \t]*\n)+/g, '{\n')
        .replace(/\n(?:[ \t]*\n)+([ \t]*\})/g, '\n$1')
        .replace(/\n(?:[ \t]*\n){2,}/g, '\n\n')
        .trimEnd()}\n`;
}

/**
 * Writes a migration with the differences between the models and the database.
 * Returns its file name, or `undefined` when there are no differences.
 *
 * @param previous the last migration, which the new one runs after
 */
async function createMigration(sequelize: Sequelize, migrationName: string, migrationsDir = './gina/migrations', previous?: string) {

    const migration = new Migration(sequelize);
    await migration.loadDatabaseTables();

    await migration.checkDiffs();

    if (!migration.upTables && !migration.upFields && !migration.upIndexes && !migration.upForeignKey) {
        console.info('There\'s no changes between your models and the database.');
        return undefined;
    }
    return migration.generateFile(migrationName, migrationsDir, previous);

}

const gina = {
    runMigrations,
    revertMigrations,
    repairMigration,
    dryRunMigrations,
    createMigration,
};

export { runMigrations, revertMigrations, repairMigration, dryRunMigrations, createMigration, DowngradeTarget, MigrationFiles };
export default gina;
