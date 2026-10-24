function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable ${name} (set it in ecosystem.config.js)`);
    process.exit(1);
  }
  return value;
}

function number(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`Environment variable ${name} must be a non-negative number, got "${raw}"`);
    process.exit(1);
  }
  return value;
}

const testMode = ['1', 'true', 'yes'].includes((process.env.TEST_MODE || '').toLowerCase());

module.exports = {
  discordToken: () => required('DISCORD_TOKEN'),
  clientId: () => required('CLIENT_ID'),
  devGuildId: process.env.DEV_GUILD_ID || null,
  testMode,
  ownerId: testMode ? required('OWNER_ID') : process.env.OWNER_ID || null,
  emulatorControlUrl: process.env.EMULATOR_CONTROL_URL || 'tcp://127.0.0.1:9601',
  eddnUrl: process.env.EDDN_URL || (testMode ? 'tcp://127.0.0.1:9600' : 'tcp://eddn.edcd.io:9500'),
  dbPath: process.env.DB_PATH || './data/carrier-tracker.db',
  rapidMoveSeconds: number('RAPID_MOVE_SECONDS', 300),
  eddnSilenceReconnectSeconds: number('EDDN_SILENCE_RECONNECT_SECONDS', 120),
};
