const { REST, Routes } = require('discord.js');
const config = require('./config');
const commands = require('./commands');

async function deployCommands() {
  const body = [...commands.values()].map((c) => c.data.toJSON());
  const rest = new REST().setToken(config.discordToken());
  const clientId = config.clientId();
  const route = config.devGuildId
    ? Routes.applicationGuildCommands(clientId, config.devGuildId)
    : Routes.applicationCommands(clientId);

  await rest.put(route, { body });
  console.log(`[discord] registered ${body.length} commands ${config.devGuildId ? `in guild ${config.devGuildId}` : 'globally'}`);
}

if (require.main === module) {
  deployCommands().catch((err) => {
    console.error('Failed to register commands:', err);
    process.exit(1);
  });
}

module.exports = { deployCommands };
