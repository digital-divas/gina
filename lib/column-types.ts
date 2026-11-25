/**
 * Conversions between Sequelize data types, MySQL column definitions and the code
 * written into generated migrations.
 */

/** A column as it currently is in the database. */
interface DatabaseColumn {
    /** e.g. `varchar(100)`, `int unsigned`, `enum('deny_list','clone')` (enum values keep their case) */
    type: string;
    allowNull: boolean;
    /** raw default as stored by the database, `null` when there's none */
    defaultValue: string | null;
    autoIncrement: boolean;
    primaryKey: boolean;
}

interface ModelDataType {
    key: string;
    options?: { [option: string]: unknown; };
    values?: string[];
    toSql(options?: { escape(value: unknown): string; }): string;
}

const INTEGER_KEYS = ['TINYINT', 'SMALLINT', 'MEDIUMINT', 'INTEGER', 'BIGINT'];
const NUMERIC_TYPES = ['tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'decimal', 'float', 'double'];

function quote(value: string) {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`;
}

function args(...values: unknown[]) {
    const defined = values.filter(value => value !== undefined && value !== null);
    return defined.length ? `(${defined.join(', ')})` : '';
}

function numericModifiers(options: { [option: string]: unknown; }) {
    return `${options.unsigned ? '.UNSIGNED' : ''}${options.zerofill ? '.ZEROFILL' : ''}`;
}

/**
 * Code that recreates a model's data type, e.g. `DataTypes.ENUM('a', 'b')` or `DataTypes.STRING(100)`.
 */
function modelTypeToCode(type: ModelDataType) {
    const options = type.options ?? {};

    switch (type.key) {
        case 'ENUM':
            return `DataTypes.ENUM(${(type.values ?? []).map(quote).join(', ')})`;
        case 'STRING':
            return `DataTypes.STRING${options.length === 255 ? '' : args(options.length)}${options.binary ? '.BINARY' : ''}`;
        case 'CHAR':
            return `DataTypes.CHAR${args(options.length)}${options.binary ? '.BINARY' : ''}`;
        case 'TEXT':
            return `DataTypes.TEXT${typeof options.length === 'string' ? `(${quote(options.length)})` : ''}`;
        case 'DECIMAL':
            return `DataTypes.DECIMAL${args(options.precision, options.scale)}${numericModifiers(options)}`;
        case 'FLOAT':
        case 'REAL':
        case 'DOUBLE':
        case 'DOUBLE PRECISION':
            return `DataTypes.${type.key.split(' ')[0]}${args(options.length, options.decimals)}${numericModifiers(options)}`;
        case 'DATE':
            return `DataTypes.DATE${args(options.length)}`;
    }

    if (INTEGER_KEYS.includes(type.key)) {
        return `DataTypes.${type.key}${args(options.length)}${numericModifiers(options)}`;
    }

    return `DataTypes.${type.key}`;
}

/**
 * Normalizes a column definition so the model's SQL and the database's can be compared:
 * `INTEGER(11) UNSIGNED` and `int unsigned` are the same thing. Quoted enum values are kept as they are.
 */
function normalizeColumnType(sql: string) {
    return sql
        .trim()
        .split(/('(?:[^'\\]|\\.|'')*')/)
        .map((part, index) => {
            if (index % 2) {
                return part.replace(/\\'/g, '\'\'');
            }
            return part
                .toLowerCase()
                .replace(/\s*([(),])\s*/g, '$1')
                .replace(/\s+/g, ' ')
                .replace(/\binteger\b/g, 'int')
                .replace(/\bdouble precision\b/g, 'double')
                .replace(/\b(smallint|mediumint|int|bigint)\(\d+\)/g, '$1')
                .replace(/\btinyint\((?!1\))\d+\)/g, 'tinyint')
                .replace(/^decimal$/, 'decimal(10,0)')
                .replace(/ binary$/, '');
        })
        .join('');
}

/**
 * The default value as the database stores it, `null` for no default and
 * `undefined` when it can't be compared (e.g. `DataTypes.NOW` or `sequelize.fn`, which never reach the database).
 */
function modelDefaultToSql(defaultValue: unknown): string | null | undefined {
    if (defaultValue === undefined || defaultValue === null) {
        return null;
    }
    if (typeof defaultValue === 'boolean') {
        return defaultValue ? '1' : '0';
    }
    if (typeof defaultValue === 'number' || typeof defaultValue === 'string') {
        return String(defaultValue);
    }
    if (typeof defaultValue === 'object' && 'val' in defaultValue) {
        return String((defaultValue as { val: unknown; }).val);
    }
    return undefined;
}

function sameDefault(modelDefault: string | null, databaseDefault: string | null) {
    if (modelDefault === null || databaseDefault === null) {
        return modelDefault === databaseDefault;
    }
    if (modelDefault.trim() !== '' && !isNaN(Number(modelDefault)) && !isNaN(Number(databaseDefault))) {
        return Number(modelDefault) === Number(databaseDefault);
    }
    return modelDefault.toLowerCase() === databaseDefault.toLowerCase() || modelDefault === databaseDefault;
}

function parseEnumValues(columnType: string) {
    return [...columnType.matchAll(/'((?:[^'\\]|\\.|'')*)'/g)].map(match => match[1].replace(/''/g, '\'').replace(/\\(.)/g, '$1'));
}

/**
 * Code that recreates a column as it is in the database, e.g. `enum('a','b')` becomes `DataTypes.ENUM('a', 'b')`.
 * Types without a DataTypes equivalent are written as raw SQL strings, which Sequelize also accepts.
 */
function databaseTypeToCode(columnType: string) {
    const match = /^(\w+)(?:\((.*)\))?\s*(.*)$/s.exec(columnType.trim());
    if (!match) {
        return quote(columnType);
    }

    const base = match[1].toLowerCase();
    const params = match[2]?.split(',').map(param => param.trim());
    const rest = match[3].toLowerCase();
    const modifiers = `${rest.includes('unsigned') ? '.UNSIGNED' : ''}${rest.includes('zerofill') ? '.ZEROFILL' : ''}`;

    switch (base) {
        case 'enum':
            return `DataTypes.ENUM(${parseEnumValues(columnType).map(quote).join(', ')})`;
        case 'varchar':
            return `DataTypes.STRING${params && params[0] !== '255' ? `(${params[0]})` : ''}`;
        case 'char':
            return `DataTypes.CHAR${params ? `(${params[0]})` : ''}`;
        case 'tinyint':
            return params?.[0] === '1' && !modifiers ? 'DataTypes.BOOLEAN' : `DataTypes.TINYINT${modifiers}`;
        case 'smallint':
            return `DataTypes.SMALLINT${modifiers}`;
        case 'mediumint':
            return `DataTypes.MEDIUMINT${modifiers}`;
        case 'int':
        case 'integer':
            return `DataTypes.INTEGER${modifiers}`;
        case 'bigint':
            return `DataTypes.BIGINT${modifiers}`;
        case 'decimal':
            return `DataTypes.DECIMAL${params ? `(${params.join(', ')})` : ''}${modifiers}`;
        case 'float':
            return `DataTypes.FLOAT${params ? `(${params.join(', ')})` : ''}${modifiers}`;
        case 'double':
            return `DataTypes.DOUBLE${params ? `(${params.join(', ')})` : ''}${modifiers}`;
        case 'datetime':
            return `DataTypes.DATE${params ? `(${params[0]})` : ''}`;
        case 'date':
            return 'DataTypes.DATEONLY';
        case 'time':
            return 'DataTypes.TIME';
        case 'text':
            return 'DataTypes.TEXT';
        case 'tinytext':
        case 'mediumtext':
        case 'longtext':
            return `DataTypes.TEXT('${base.replace('text', '')}')`;
        case 'json':
            return 'DataTypes.JSON';
        case 'blob':
            return 'DataTypes.BLOB';
        case 'tinyblob':
        case 'mediumblob':
        case 'longblob':
            return `DataTypes.BLOB('${base.replace('blob', '')}')`;
    }

    return quote(columnType);
}

/**
 * Code for a database default value, typed after the column (numbers, booleans, literals or strings).
 * Returns `needsSequelize` when it uses `Sequelize.literal`.
 */
function databaseDefaultToCode(defaultValue: string, columnType: string) {
    const base = columnType.trim().toLowerCase();

    if (/^current_timestamp/.test(defaultValue.toLowerCase())) {
        return { code: `Sequelize.literal(${quote(defaultValue)})`, needsSequelize: true };
    }
    if (base.startsWith('tinyint(1)')) {
        return { code: defaultValue === '0' ? 'false' : 'true', needsSequelize: false };
    }
    if (NUMERIC_TYPES.some(type => base.startsWith(type)) && !isNaN(Number(defaultValue))) {
        return { code: String(Number(defaultValue)), needsSequelize: false };
    }
    return { code: quote(defaultValue), needsSequelize: false };
}

export {
    DatabaseColumn,
    ModelDataType,
    quote,
    modelTypeToCode,
    normalizeColumnType,
    modelDefaultToSql,
    sameDefault,
    databaseTypeToCode,
    databaseDefaultToCode,
};
