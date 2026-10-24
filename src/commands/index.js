const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

const commands = new Map();
for (const file of fs.readdirSync(__dirname).filter((f) => f.endsWith('.js') && f !== 'index.js')) {
  if (file === 'test.js' && !config.testMode) continue;
  const command = require(path.join(__dirname, file));
  commands.set(command.data.name, command);
}

module.exports = commands;
