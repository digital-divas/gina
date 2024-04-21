import { Model, Sequelize, InferAttributes, InferCreationAttributes, CreationOptional, DataTypes } from 'sequelize';

class GinaVersion extends Model<InferAttributes<GinaVersion>, InferCreationAttributes<GinaVersion>> {
    // fields
    declare id: CreationOptional<number>;
    declare version: string;

    // auto-generated fields
    declare createdAt: CreationOptional<Date>;
    declare updatedAt: CreationOptional<Date>;
}

function initializeModel(sequelize: Sequelize) {
    GinaVersion.init({
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        version: {
            type: DataTypes.STRING,
            allowNull: false,
            field: 'version'
        },
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
    }, {
        tableName: 'gina_version',
        sequelize
    });

    return () => {
        return;
    };

}

export { GinaVersion, initializeModel };
