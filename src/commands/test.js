const { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const config = require('../config');
const { sendControl } = require('../emulatorControl');
const { normalizeCallsign } = require('../parser');

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
  const ephemeral = { flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
  if (interaction.user.id !== config.ownerId) {
    return interaction.reply({ content: 'Only the bot owner can use test commands.', ...ephemeral });
  }

  const sub = interaction.options.getSubcommand();
  const request = { cmd: sub };
  if (sub !== 'status') {
    const callsign = normalizeCallsign(interaction.options.getString('callsign', true));
    if (!callsign) return interaction.reply({ content: 'Callsign must look like `ABC-123`.', ...ephemeral });
    request.callsign = callsign;
  }
  if (['jump', 'dock', 'market'].includes(sub)) request.system = interaction.options.getString('system', true).trim();
  if (sub === 'dock') request.uploader = interaction.options.getString('uploader') || undefined;
  if (sub === 'scenario') request.name = interaction.options.getString('name', true).trim();

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const reply = await sendControl(request);
    await interaction.editReply({ content: `\`\`\`json\n${JSON.stringify(reply, null, 2)}\n\`\`\``, allowedMentions: { parse: [] } });
  } catch (err) {
    await interaction.editReply({ content: `Emulator error: ${err.message}`, allowedMentions: { parse: [] } });
  }
}

module.exports = { data, execute };
