// A migration that fails after applying its first step: the index points to a column that
// doesn't exist. run.sh copies it into the project, replaces PREVIOUS and later fixes the index.
import { QueryInterface, DataTypes } from 'sequelize';

export const previous = 'PREVIOUS';

export const migration = {
    async up(queryInterface: QueryInterface) {
        await queryInterface.addColumn('users', 'halfway', { type: DataTypes.STRING, allowNull: true });
        await queryInterface.addIndex('users', { fields: ['missing_column'], name: 'users_halfway' });
    },

    async down(queryInterface: QueryInterface) {
        await queryInterface.removeIndex('users', 'users_halfway');
        await queryInterface.removeColumn('users', 'halfway');
    },
};
