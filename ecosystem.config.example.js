// Copy to ecosystem.config.js (git-ignored) and fill in real values.
const env = {
  DISCORD_TOKEN: 'your-bot-token',
  CLIENT_ID: 'your-application-id',
  // Set to register commands instantly in one guild; leave empty for global registration.
  DEV_GUILD_ID: '',
  // Empty = real EDDN, or the local emulator (tcp://127.0.0.1:9600) when TEST_MODE is on.
  EDDN_URL: '',
  DB_PATH: './data/carrier-tracker.db',
  RAPID_MOVE_SECONDS: '300',
  EDDN_SILENCE_RECONNECT_SECONDS: '120',
  // Set TEST_MODE to '1' to use py-eddn-tools/eddn_emulator.py and enable the owner-only /test command.
  TEST_MODE: '',
  OWNER_ID: '',
  EMULATOR_CONTROL_URL: 'tcp://127.0.0.1:9601',
};

module.exports = {
  apps: [
    {
      name: 'carrier-tracker',
      script: 'src/index.js',
      exec_mode: 'fork',
      instances: 1,
      kill_timeout: 10000,
      shutdown_with_message: true,
      env,
    },
  ],
};
