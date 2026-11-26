import { Model, Sequelize, InferAttributes, InferCreationAttributes, CreationOptional, DataTypes, ForeignKey } from 'sequelize';
import { User } from './user';

export enum PostStatus {
    DRAFT = 'draft',
    PUBLISHED = 'published',
    ARCHIVED = 'archived',
}

export class Post extends Model<InferAttributes<Post>, InferCreationAttributes<Post>> {
    declare id: CreationOptional<number>;
    declare userId: ForeignKey<User['id']>;
    declare title: string;
    declare views: CreationOptional<number>;
    declare status: CreationOptional<PostStatus>;
    declare rating: number | null;
    declare publishedAt: Date | null;
    declare body: CreationOptional<string>;
    declare slug: string | null;
    declare createdAt: CreationOptional<Date>;
    declare updatedAt: CreationOptional<Date>;
}

export function initializeModel(sequelize: Sequelize) {
    Post.init({
        id: {
            type: DataTypes.BIGINT,
            autoIncrement: true,
            primaryKey: true,
            field: 'id'
        },
        userId: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'users',
                key: 'id'
            },
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
            field: 'user_id'
        },
        title: {
            type: DataTypes.STRING,
            allowNull: false,
            field: 'title'
        },
        views: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 10,
            field: 'views'
        },
        status: {
            type: DataTypes.ENUM(...Object.values(PostStatus)),
            allowNull: false,
            defaultValue: PostStatus.DRAFT,
            field: 'status'
        },
        rating: {
            type: DataTypes.DECIMAL(3, 1),
            allowNull: true,
            field: 'rating'
        },
        publishedAt: {
            type: DataTypes.DATE,
            allowNull: true,
            field: 'published_at'
        },
        // MySQL can't store a default for TEXT columns: the default only applies when Sequelize creates a row
        body: {
            type: DataTypes.TEXT('medium'),
            allowNull: false,
            defaultValue: '',
            field: 'body'
        },
        // unique index declared on the attribute
        slug: {
            type: DataTypes.STRING(100),
            allowNull: true,
            unique: true,
            field: 'slug'
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
        tableName: 'posts',
        indexes: [{
            name: 'posts_user_published',
            unique: false,
            fields: [{ name: 'user_id' }, { name: 'published_at', order: 'DESC' }]
        }],
        sequelize
    });

    return () => {
        Post.belongsTo(User, { foreignKey: 'userId', as: 'user' });
        User.hasMany(Post, { foreignKey: 'userId', as: 'posts' });
    };
}
