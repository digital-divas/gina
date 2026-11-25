#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */

// Prefer the gina installed in the project being migrated, so models, migrations
// and gina share the same sequelize copy even when gina-cli was installed globally.
const path = require('path');

let cli = path.join(__dirname, '..', 'dist', 'cli.js');
try {
    cli = require.resolve('gina-sequelize/dist/cli.js', { paths: [process.cwd()] });
} catch {
    // not installed on the project (or an old version without dist/cli.js)
}

require(cli);
