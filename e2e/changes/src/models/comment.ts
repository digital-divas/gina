import { Model, Sequelize, InferAttributes, InferCreationAttributes, CreationOptional, DataTypes, ForeignKey } from 'sequelize';
import { Post } from './post';

export class Comment extends Model<InferAttributes<Comment>, InferCreationAttributes<Comment>> {
    declare id: CreationOptional<number>;
    declare postId: ForeignKey<Post['id']>;
    declare body: string;
    declare createdAt: CreationOptional<Date>;
    declare updatedAt: CreationOptional<Date>;
}

export function initializeModel(sequelize: Sequelize) {
    Comment.init({
        id: {
            type: DataTypes.INTEGER,
            autoIncrement: true,
            primaryKey: true,
            field: 'id'
        },
        postId: {
            type: DataTypes.BIGINT,
            allowNull: false,
            references: {
                model: 'posts',
                key: 'id'
            },
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
            field: 'post_id'
        },
        body: {
            type: DataTypes.TEXT,
            allowNull: false,
            field: 'body'
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
        tableName: 'comments',
        sequelize
    });

    return () => {
        Comment.belongsTo(Post, { foreignKey: 'postId', as: 'post' });
    };
}
