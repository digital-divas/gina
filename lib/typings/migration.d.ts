import { QueryInterface } from 'sequelize';

interface MigrationFile {
    up(queryInterface: QueryInterface): Promise<void>;
    down(queryInterface: QueryInterface): Promise<void>;
}
