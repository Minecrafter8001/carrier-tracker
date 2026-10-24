const { EmbedBuilder } = require('discord.js');

const COLORS = { firstSeen: 0x2ecc71, moved: 0xf39c12 };

function buildEmbed({ type, label, callsign, from, to, sighting }) {
  const description = type === 'moved' ? `**${from}** → **${to}**` : `First seen in **${to}**`;
  const source = [sighting.schema, sighting.event].filter(Boolean).join(' / ');
  return new EmbedBuilder()
    .setColor(COLORS[type])
    .setTitle(label ? `${callsign} (${label})` : callsign)
    .setDescription(`${description}\n<t:${Math.floor(sighting.ts / 1000)}:R>`)
    .setFooter({ text: `EDDN ${source}` })
    .setTimestamp(sighting.ts);
}

function createAlertSender(client) {
  return async (alert) => {
    if (!alert.channelId) {
      console.warn(`[alerts] guild ${alert.guildId} has no alert channel; skipped ${alert.type} for ${alert.callsign}`);
      return;
    }
    try {
      const channel = await client.channels.fetch(alert.channelId);
      if (!channel?.isSendable()) throw new Error('channel is not sendable');
      await channel.send({ embeds: [buildEmbed(alert)], allowedMentions: { parse: [] } });
    } catch (err) {
      console.warn(`[alerts] failed to send to ${alert.channelId} in guild ${alert.guildId}: ${err.message}`);
    }
  };
}

module.exports = { createAlertSender };
