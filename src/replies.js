const { EmbedBuilder, MessageFlags } = require('discord.js');

const COLORS = { success: 0x2ecc71, info: 0x3498db, error: 0xe74c3c };

function carrierName(callsign, label) {
  return label ? `${label} (${callsign})` : callsign;
}

function carrierNameMarkdown(callsign, label) {
  return label ? `**${label}** (\`${callsign}\`)` : `**${callsign}**`;
}

function buildEmbed({ kind = 'info', title, description }) {
  const embed = new EmbedBuilder()
    .setColor(COLORS[kind] ?? COLORS.info)
    .setDescription(description);
  if (title) embed.setTitle(title);
  return embed;
}

function respond(interaction, { kind = 'info', title, description, ephemeral = kind === 'error' }) {
  const payload = {
    embeds: [buildEmbed({ kind, title, description })],
    allowedMentions: { parse: [] },
  };

  if (interaction.deferred && !interaction.replied) return interaction.editReply(payload);
  if (interaction.replied) return interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
  return interaction.reply({ ...payload, flags: ephemeral ? MessageFlags.Ephemeral : undefined });
}

module.exports = { buildEmbed, carrierName, carrierNameMarkdown, respond };