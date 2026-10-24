const {
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const db = require('../db');
const { normalizeCallsign } = require('../parser');
const { fetchCarrierName } = require('../inara');
const { carrierName, carrierNameMarkdown, respond } = require('../replies');

const MAX_PER_GUILD = 25;

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

function formatLastSeen(row) {
  if (!row.system) return 'not yet seen';
  return `**${row.system}** <t:${Math.floor(row.last_ts / 1000)}:R>`;
}

async function execute(interaction, { tracker }) {
  if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return respond(interaction, { kind: 'error', description: 'You need the Manage Server permission to use this command.' });
  }

  const guildId = interaction.guildId;
  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const callsign = normalizeCallsign(interaction.options.getString('callsign', true));
    if (!callsign) return respond(interaction, { kind: 'error', description: 'Callsign must look like `ABC-123`.' });
    let label = interaction.options.getString('label')?.trim() || null;
    const alreadyTracked = db.isTracked(guildId, callsign);

    if (!alreadyTracked && db.countTracked(guildId) >= MAX_PER_GUILD) {
      return respond(interaction, {
        kind: 'error',
        description: `This server already tracks the maximum of ${MAX_PER_GUILD} carriers.`,
      });
    }

    if (!label && !alreadyTracked) {
      await interaction.deferReply();
      label = await fetchCarrierName(callsign);
    }

    db.addTracked({ guildId, callsign, label, addedBy: interaction.user.id, addedAt: Date.now() });
    tracker.refresh();
    label = db.getLabel(guildId, callsign);

    const lines = ["You'll get an alert on its next EDDN sighting."];
    if (!db.getChannel(guildId)) lines.push('No alert channel set yet; use `/track channel`.');
    return respond(interaction, {
      kind: 'success',
      title: `Now tracking ${carrierName(callsign, label)}`,
      description: lines.join('\n'),
    });
  }

  if (sub === 'remove') {
    const callsign = normalizeCallsign(interaction.options.getString('callsign', true));
    if (!callsign) return respond(interaction, { kind: 'error', description: 'Callsign must look like `ABC-123`.' });
    const label = db.getLabel(guildId, callsign);
    if (!db.removeTracked(guildId, callsign)) {
      return respond(interaction, { kind: 'error', description: 'That carrier is not tracked in this server.' });
    }
    tracker.refresh();
    return respond(interaction, {
      kind: 'success',
      description: `Stopped tracking ${carrierNameMarkdown(callsign, label)}.`,
    });
  }

  if (sub === 'list') {
    const rows = db.listTracked(guildId);
    if (!rows.length) {
      return respond(interaction, { kind: 'info', description: 'No carriers tracked yet. Use `/track add`.', ephemeral: true });
    }
    const lines = rows.map((r) => `${carrierNameMarkdown(r.callsign, r.label)}: ${formatLastSeen(r)}`);
    return respond(interaction, { kind: 'info', title: `Tracked carriers (${rows.length})`, description: lines.join('\n') });
  }

  if (sub === 'channel') {
    const channel = interaction.options.getChannel('channel', true);
    const perms = channel.permissionsFor?.(interaction.client.user);
    const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
    if (!perms?.has(needed)) {
      return respond(interaction, {
        kind: 'error',
        description: `I need View Channel, Send Messages and Embed Links in ${channel}.`,
      });
    }
    db.setChannel(guildId, channel.id);
    return respond(interaction, { kind: 'success', description: `Movement alerts will be posted in ${channel}.` });
  }
}

module.exports = { data, execute, formatLastSeen };
