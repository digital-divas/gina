import { Model, Sequelize, InferAttributes, InferCreationAttributes, CreationOptional, DataTypes } from 'sequelize';

export class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
    declare id: CreationOptional<number>;
    declare name: string;
    declare email: string;
    declare isActive: CreationOptional<boolean>;
    declare age: CreationOptional<number>;
    declare nickname: string | null;
    declare createdAt: CreationOptional<Date>;
    declare updatedAt: CreationOptional<Date>;
}

export function initializeModel(sequelize: Sequelize) {
    User.init({
        id: {
            type: DataTypes.INTEGER,
            autoIncrement: true,
            primaryKey: true,
            field: 'id'
        },
        name: {
            type: DataTypes.STRING,
            allowNull: false,
            field: 'name'
        },
        email: {
            type: DataTypes.STRING(200),
            allowNull: false,
            field: 'email'
        },
        isActive: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: true,
            field: 'is_active'
        },
        age: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
            field: 'age'
        },
        nickname: {
            type: DataTypes.STRING,
            allowNull: true,
            field: 'nickname'
        },
        createdAt: {
            type: DataTypes.DATE,
            field: 'created_at'
        },
        updatedAt: {
            type: DataTypes.DATE,
            field: 'updated_at'
        },
    }, {
        tableName: 'users',
        indexes: [{
            name: 'users_email_unique',
            unique: true,
            fields: ['email']
        }, {
            name: 'users_name',
            unique: false,
            fields: ['name']
        }],
        sequelize
    });

    return () => undefined;
}
