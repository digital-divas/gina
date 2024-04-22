# Gina

Gina is a tool to auto-generate and run migrations based on Sequelize ORM.

## How to use it

### Install

You can install this using:

```bash
npm install gina-sequelize
```

You'll need to install it globally so you can you the gina-cli

```bash
npm install -g gina-sequelize
# make sure to install ts-node too:
npm install -g ts-node
```

### Initialize Gina

If this is the first time you are running Gina on your project you'll need to initialize it.

```bash
gina-cli init
```

This will generate a folder `gina` to your project.
Inside this folder you will find the file `initializeModels.ts`.
You will need to modify this file so that the `initializeModels` method inside it return a valid sequelize instance object that *has all your models ALREADY loaded*.

### Upgrade database

Once you have the `initializeModels` configured you can upgrade your database using:

```bash
gina-cli upgrade
```

### Generating new migration

Once you have the `initializeModels` configured you can generate auto migrations.
It'll compare your loaded models with the database that you are connected.
All differences should be listed on a new migration file that will be placed inside the folder `gina/migrations`.

```bash
gina-cli generate-migration "Creating user table"
```

## Development

If you want to edit the cli and test it you can install it locally:

```bash
npm install -g .
```
