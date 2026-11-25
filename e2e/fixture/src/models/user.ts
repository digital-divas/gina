import { Model, Sequelize, InferAttributes, InferCreationAttributes, CreationOptional, DataTypes } from 'sequelize';

export class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
    declare id: CreationOptional<number>;
    declare name: string;
    declare email: string;
    declare isActive: CreationOptional<boolean>;
    declare age: number | null;
    declare bio: string | null;
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
            type: DataTypes.STRING(150),
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
            allowNull: true,
            field: 'age'
        },
        bio: {
            type: DataTypes.TEXT,
            allowNull: true,
            field: 'bio'
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
        }],
        sequelize
    });

    return () => undefined;
}
