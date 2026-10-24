const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const db = require('../db');
const { normalizeCallsign } = require('../parser');
const { formatLastSeen } = require('./track');

const data = new SlashCommandBuilder()
  .setName('where')
  .setDescription('Show the last known location of a fleet carrier')
  .addStringOption((o) =>
    o.setName('callsign').setDescription('Carrier callsign, e.g. ABC-123').setRequired(true).setMinLength(7).setMaxLength(7),
  );

async function execute(interaction) {
  const callsign = normalizeCallsign(interaction.options.getString('callsign', true));
  if (!callsign) {
    return interaction.reply({ content: 'Callsign must look like `ABC-123`.', flags: MessageFlags.Ephemeral });
  }
  const state = db.getState(callsign);
  const content = state?.system
    ? `**${callsign}** was last seen in ${formatLastSeen(state)}.`
    : `No sightings of **${callsign}** yet. Only carriers tracked with \`/track add\` are recorded.`;
  return interaction.reply({ content, allowedMentions: { parse: [] } });
}

module.exports = { data, execute };
