const { Client, Events, GatewayIntentBits, MessageFlags } = require('discord.js');
const config = require('./config');
const db = require('./db');
const commands = require('./commands');
const { EddnClient } = require('./eddn');
const { parseSighting } = require('./parser');
const { Tracker } = require('./tracker');
const { createAlertSender } = require('./alerts');
const { deployCommands } = require('./deploy-commands');

db.open(config.dbPath);

const tracker = new Tracker({ rapidMoveSeconds: config.rapidMoveSeconds });
const eddn = new EddnClient({ url: config.eddnUrl, silenceSeconds: config.eddnSilenceReconnectSeconds });
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

eddn.on('message', (doc) => {
  const sighting = parseSighting(doc);
  if (!sighting) return;
  try {
    tracker.handle(sighting);
  } catch (err) {
    console.error('[tracker] failed to handle sighting:', err);
  }
});

client.once(Events.ClientReady, (c) => {
  console.log(`[discord] logged in as ${c.user.tag}`);
  deployCommands().catch((err) => console.error('[discord] failed to register commands:', err.message));
  tracker.on('alert', createAlertSender(client));
  eddn.start();
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = commands.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction, { tracker });
  } catch (err) {
    console.error(`[discord] /${interaction.commandName} failed:`, err);
    const payload = { content: 'Something went wrong running that command.', flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
});

let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[main] shutting down (${reason})`);
  try {
    await eddn.stop();
    await client.destroy();
  } finally {
    db.close();
    console.log('[main] shutdown complete');
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// pm2 sends this instead of a signal when shutdown_with_message is enabled (needed on Windows).
process.on('message', (msg) => {
  if (msg === 'shutdown') shutdown('pm2');
});

client.login(config.discordToken()).catch((err) => {
  console.error('[discord] login failed:', err.message);
  db.close();
  process.exit(1);
});
