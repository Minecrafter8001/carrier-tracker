// Copy to ecosystem.config.js (git-ignored) and fill in real values.
const env = {
  DISCORD_TOKEN: 'your-bot-token',
  CLIENT_ID: 'your-application-id',
  // Set to register commands instantly in one guild; leave empty for global registration.
  DEV_GUILD_ID: '',
  EDDN_URL: 'tcp://eddn.edcd.io:9500',
  DB_PATH: './data/carrier-tracker.db',
  RAPID_MOVE_SECONDS: '300',
  EDDN_SILENCE_RECONNECT_SECONDS: '120',
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
    {
      name: 'deploy-commands',
      script: 'src/deploy-commands.js',
      autorestart: false,
      env,
    },
  ],
};
