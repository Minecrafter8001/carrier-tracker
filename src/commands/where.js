const { SlashCommandBuilder } = require('discord.js');
const db = require('../db');
const { normalizeCallsign } = require('../parser');
const { carrierName, respond } = require('../replies');
const { formatLastSeen } = require('./track');

const data = new SlashCommandBuilder()
  .setName('where')
  .setDescription('Show the last known location of a fleet carrier')
  .addStringOption((o) =>
    o.setName('callsign').setDescription('Carrier callsign, e.g. ABC-123').setRequired(true).setMinLength(7).setMaxLength(7),
  );

async function execute(interaction) {
  const callsign = normalizeCallsign(interaction.options.getString('callsign', true));
  if (!callsign) return respond(interaction, { kind: 'error', description: 'Callsign must look like `ABC-123`.' });
  const label = interaction.inGuild() ? db.getLabel(interaction.guildId, callsign) : null;
  const state = db.getState(callsign);
  const description = state?.system
    ? `Last seen in ${formatLastSeen(state)}`
    : 'No sightings yet. Only carriers tracked with `/track add` are recorded.';
  return respond(interaction, { kind: 'info', title: carrierName(callsign, label), description });
}

module.exports = { data, execute };
