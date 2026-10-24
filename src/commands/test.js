const { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const config = require('../config');
const { sendControl } = require('../emulatorControl');
const { normalizeCallsign } = require('../parser');
const { respond } = require('../replies');

const callsignOption = (o) =>
  o.setName('callsign').setDescription('Carrier callsign, e.g. ABC-123').setRequired(true).setMinLength(7).setMaxLength(7);
const systemOption = (o) => o.setName('system').setDescription('Star system').setRequired(true).setMaxLength(100);

const data = new SlashCommandBuilder()
  .setName('test')
  .setDescription('Send test messages through the EDDN emulator (test mode only)')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub.setName('jump').setDescription('CarrierJump journal event').addStringOption(callsignOption).addStringOption(systemOption),
  )
  .addSubcommand((sub) =>
    sub
      .setName('dock')
      .setDescription('Docked journal event')
      .addStringOption(callsignOption)
      .addStringOption(systemOption)
      .addStringOption((o) => o.setName('uploader').setDescription('Uploader ID (default test-emulator)').setMaxLength(64)),
  )
  .addSubcommand((sub) =>
    sub.setName('market').setDescription('commodity/3 market update').addStringOption(callsignOption).addStringOption(systemOption),
  )
  .addSubcommand((sub) =>
    sub
      .setName('scenario')
      .setDescription('Run a scripted scenario from py-eddn-tools/scenarios')
      .addStringOption((o) => o.setName('name').setDescription('Scenario name').setRequired(true).setMaxLength(64))
      .addStringOption(callsignOption),
  )
  .addSubcommand((sub) => sub.setName('status').setDescription('Emulator status and available scenarios'));

async function execute(interaction) {
  if (interaction.user.id !== config.ownerId) {
    return respond(interaction, { kind: 'error', description: 'Only the bot owner can use test commands.' });
  }

  const sub = interaction.options.getSubcommand();
  const request = { cmd: sub };
  if (sub !== 'status') {
    const callsign = normalizeCallsign(interaction.options.getString('callsign', true));
    if (!callsign) return respond(interaction, { kind: 'error', description: 'Callsign must look like `ABC-123`.' });
    request.callsign = callsign;
  }
  if (['jump', 'dock', 'market'].includes(sub)) request.system = interaction.options.getString('system', true).trim();
  if (sub === 'dock') request.uploader = interaction.options.getString('uploader') || undefined;
  if (sub === 'scenario') request.name = interaction.options.getString('name', true).trim();

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const result = await sendControl(request);
    await respond(interaction, {
      kind: result.ok ? 'success' : 'error',
      title: `/test ${sub}`,
      description: `\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``,
    });
  } catch (err) {
    await respond(interaction, { kind: 'error', title: `/test ${sub}`, description: `Emulator error: ${err.message}` });
  }
}

module.exports = { data, execute };
