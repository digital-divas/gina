// A migration from a branch merged after another one that also added a migration.
// run.sh copies it into the project and replaces PREVIOUS.
import { QueryInterface, DataTypes } from 'sequelize';

export const previous = 'PREVIOUS';

export const migration = {
    async up(queryInterface: QueryInterface) {
        await queryInterface.createTable('late_branch', {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
        });
    },

    async down(queryInterface: QueryInterface) {
        await queryInterface.dropTable('late_branch');
    },
};
