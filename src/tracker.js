const { EventEmitter } = require('node:events');
const db = require('./db');

const MAX_FUTURE_SKEW_MS = 5 * 60_000;

/**
 * Applies sightings to carrier_state and emits `alert` events:
 * { type: 'firstSeen' | 'moved', guildId, channelId, label, callsign, from, to, sighting }
 */
class Tracker extends EventEmitter {
  constructor({ rapidMoveSeconds }) {
    super();
    this.rapidMoveMs = rapidMoveSeconds * 1000;
    this.tracked = new Set();
    this.refresh();
  }

  refresh() {
    this.tracked = new Set(db.allTrackedCallsigns());
  }

  handle(sighting) {
    const { callsign, marketId, system, ts, uploader } = sighting;
    if (!this.tracked.has(callsign)) return;
    if (ts > Date.now() + MAX_FUTURE_SKEW_MS) return;

    db.ensureState(callsign);
    if (marketId !== null) db.setMarketId(callsign, marketId);
    if (system === null) return;

    const state = db.getState(callsign);
    if (state.last_ts !== null && ts <= state.last_ts) return;

    const row = { callsign, system, ts, uploader };
    let moved = false;

    if (state.system === null) {
      db.setPosition(row);
    } else if (state.system === system) {
      db.touch(row);
      if (state.pending_system !== null) db.clearPending(callsign);
    } else if (this.isConfirmedMove(state, sighting)) {
      db.setPosition(row);
      moved = true;
    } else {
      if (state.pending_system !== system) db.setPending(row);
      console.log(`[tracker] ${callsign} pending move ${state.system} -> ${system} (awaiting confirmation)`);
      return;
    }

    this.notify(sighting, moved ? state.system : null);
  }

  // Moves seen soon after the last sighting are held until a second independent report confirms them.
  isConfirmedMove(state, { system, ts, uploader, authoritative }) {
    if (authoritative) return true;
    if (ts - state.last_ts >= this.rapidMoveMs) return true;
    if (state.pending_system !== system) return false;
    return uploader !== state.pending_uploader || ts - state.pending_ts >= this.rapidMoveMs;
  }

  notify(sighting, from) {
    const { callsign, system } = sighting;
    for (const guild of db.guildsTracking(callsign)) {
      let type = null;
      if (!guild.first_seen_notified) {
        type = 'firstSeen';
        db.markFirstSeen(guild.guild_id, callsign);
      } else if (from !== null) {
        type = 'moved';
      }
      if (!type) continue;
      this.emit('alert', {
        type,
        guildId: guild.guild_id,
        channelId: guild.channel_id,
        label: guild.label,
        callsign,
        from,
        to: system,
        sighting,
      });
    }
    if (from !== null) console.log(`[tracker] ${callsign} moved ${from} -> ${system}`);
  }
}

module.exports = { Tracker };
