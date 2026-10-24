const { REST, Routes } = require('discord.js');
const config = require('./config');
const commands = require('./commands');

async function main() {
  const body = [...commands.values()].map((c) => c.data.toJSON());
  const rest = new REST().setToken(config.discordToken());
  const clientId = config.clientId();
  const route = config.devGuildId
    ? Routes.applicationGuildCommands(clientId, config.devGuildId)
    : Routes.applicationCommands(clientId);

  await rest.put(route, { body });
  console.log(`Registered ${body.length} commands ${config.devGuildId ? `in guild ${config.devGuildId}` : 'globally'}.`);
}

main().catch((err) => {
  console.error('Failed to register commands:', err);
  process.exit(1);
});
