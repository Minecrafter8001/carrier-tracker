const {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const db = require('../db');
const { normalizeCallsign } = require('../parser');
const { fetchCarrierName } = require('../inara');

const MAX_PER_GUILD = 25;
const NO_MENTIONS = { parse: [] };

const data = new SlashCommandBuilder()
  .setName('track')
  .setDescription('Manage tracked fleet carriers')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Track a fleet carrier')
      .addStringOption((o) =>
        o.setName('callsign').setDescription('Carrier callsign, e.g. ABC-123').setRequired(true).setMinLength(7).setMaxLength(7),
      )
      .addStringOption((o) =>
        o.setName('label').setDescription('Friendly name (looked up on Inara if omitted)').setMaxLength(50),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Stop tracking a fleet carrier')
      .addStringOption((o) => o.setName('callsign').setDescription('Carrier callsign').setRequired(true).setMinLength(7).setMaxLength(7)),
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('List tracked fleet carriers'))
  .addSubcommand((sub) =>
    sub
      .setName('channel')
      .setDescription('Set the channel for movement alerts')
      .addChannelOption((o) =>
        o
          .setName('channel')
          .setDescription('Alert channel')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      ),
  );

function reply(interaction, content, ephemeral = false) {
  if (interaction.deferred) return interaction.editReply({ content, allowedMentions: NO_MENTIONS });
  return interaction.reply({
    content,
    allowedMentions: NO_MENTIONS,
    flags: ephemeral ? MessageFlags.Ephemeral : undefined,
  });
}

function formatLastSeen(row) {
  if (!row.system) return 'not yet seen';
  return `**${row.system}** <t:${Math.floor(row.last_ts / 1000)}:R>`;
}

async function execute(interaction, { tracker }) {
  if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return reply(interaction, 'You need the Manage Server permission to use this command.', true);
  }

  const guildId = interaction.guildId;
  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const callsign = normalizeCallsign(interaction.options.getString('callsign', true));
    if (!callsign) return reply(interaction, 'Callsign must look like `ABC-123`.', true);
    let label = interaction.options.getString('label')?.trim() || null;
    const alreadyTracked = db.isTracked(guildId, callsign);

    if (!alreadyTracked && db.countTracked(guildId) >= MAX_PER_GUILD) {
      return reply(interaction, `This server already tracks the maximum of ${MAX_PER_GUILD} carriers.`, true);
    }

    if (!label && !alreadyTracked) {
      await interaction.deferReply();
      label = await fetchCarrierName(callsign);
    }

    db.addTracked({ guildId, callsign, label, addedBy: interaction.user.id, addedAt: Date.now() });
    tracker.refresh();
    label = db.getLabel(guildId, callsign);

    const lines = [`Now tracking **${callsign}**${label ? ` (${label})` : ''}. You'll get an alert on its next EDDN sighting.`];
    if (!db.getChannel(guildId)) lines.push('No alert channel set yet; use `/track channel`.');
    return reply(interaction, lines.join('\n'));
  }

  if (sub === 'remove') {
    const callsign = normalizeCallsign(interaction.options.getString('callsign', true));
    if (!callsign || !db.removeTracked(guildId, callsign)) {
      return reply(interaction, 'That carrier is not tracked in this server.', true);
    }
    tracker.refresh();
    return reply(interaction, `Stopped tracking **${callsign}**.`);
  }

  if (sub === 'list') {
    const rows = db.listTracked(guildId);
    if (!rows.length) return reply(interaction, 'No carriers tracked yet. Use `/track add`.', true);
    const lines = rows.map((r) => `\`${r.callsign}\`${r.label ? ` ${r.label}` : ''}: ${formatLastSeen(r)}`);
    return reply(interaction, lines.join('\n'));
  }

  if (sub === 'channel') {
    const channel = interaction.options.getChannel('channel', true);
    const perms = channel.permissionsFor?.(interaction.client.user);
    const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
    if (!perms?.has(needed)) {
      return reply(interaction, `I need View Channel, Send Messages and Embed Links in ${channel}.`, true);
    }
    db.setChannel(guildId, channel.id);
    return reply(interaction, `Movement alerts will be posted in ${channel}.`);
  }
}

module.exports = { data, execute, formatLastSeen };
