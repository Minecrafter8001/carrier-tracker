const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

let db;
let stmts;

function open(dbPath) {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS guild_config (
      guild_id   TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tracked (
      guild_id            TEXT NOT NULL,
      callsign            TEXT NOT NULL,
      label               TEXT,
      added_by            TEXT NOT NULL,
      added_at            INTEGER NOT NULL,
      first_seen_notified INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, callsign)
    );
    CREATE INDEX IF NOT EXISTS tracked_callsign ON tracked (callsign);

    CREATE TABLE IF NOT EXISTS carrier_state (
      callsign         TEXT PRIMARY KEY,
      market_id        INTEGER,
      system           TEXT,
      last_ts          INTEGER,
      last_uploader    TEXT,
      pending_system   TEXT,
      pending_ts       INTEGER,
      pending_uploader TEXT
    );
    CREATE INDEX IF NOT EXISTS carrier_state_market ON carrier_state (market_id);
  `);

  stmts = {
    getChannel: db.prepare('SELECT channel_id FROM guild_config WHERE guild_id = ?'),
    setChannel: db.prepare(`
      INSERT INTO guild_config (guild_id, channel_id) VALUES (?, ?)
      ON CONFLICT (guild_id) DO UPDATE SET channel_id = excluded.channel_id
    `),

    addTracked: db.prepare(`
      INSERT INTO tracked (guild_id, callsign, label, added_by, added_at)
      VALUES (@guildId, @callsign, @label, @addedBy, @addedAt)
      ON CONFLICT (guild_id, callsign) DO UPDATE SET label = excluded.label
    `),
    removeTracked: db.prepare('DELETE FROM tracked WHERE guild_id = ? AND callsign = ?'),
    countTracked: db.prepare('SELECT COUNT(*) AS n FROM tracked WHERE guild_id = ?'),
    isTracked: db.prepare('SELECT 1 FROM tracked WHERE guild_id = ? AND callsign = ?'),
    listTracked: db.prepare(`
      SELECT t.callsign, t.label, s.system, s.last_ts
      FROM tracked t LEFT JOIN carrier_state s ON s.callsign = t.callsign
      WHERE t.guild_id = ?
      ORDER BY t.callsign
    `),
    allTrackedCallsigns: db.prepare('SELECT DISTINCT callsign FROM tracked'),
    guildsTracking: db.prepare(`
      SELECT t.guild_id, t.label, t.first_seen_notified, g.channel_id
      FROM tracked t LEFT JOIN guild_config g ON g.guild_id = t.guild_id
      WHERE t.callsign = ?
    `),
    markFirstSeen: db.prepare('UPDATE tracked SET first_seen_notified = 1 WHERE guild_id = ? AND callsign = ?'),

    getState: db.prepare('SELECT * FROM carrier_state WHERE callsign = ?'),
    callsignByMarketId: db.prepare('SELECT callsign FROM carrier_state WHERE market_id = ?'),
    ensureState: db.prepare('INSERT OR IGNORE INTO carrier_state (callsign) VALUES (?)'),
    setMarketId: db.prepare('UPDATE carrier_state SET market_id = ? WHERE callsign = ? AND market_id IS NULL'),
    setPosition: db.prepare(`
      UPDATE carrier_state
      SET system = @system, last_ts = @ts, last_uploader = @uploader,
          pending_system = NULL, pending_ts = NULL, pending_uploader = NULL
      WHERE callsign = @callsign
    `),
    touch: db.prepare('UPDATE carrier_state SET last_ts = @ts, last_uploader = @uploader WHERE callsign = @callsign'),
    setPending: db.prepare(`
      UPDATE carrier_state
      SET pending_system = @system, pending_ts = @ts, pending_uploader = @uploader
      WHERE callsign = @callsign
    `),
    clearPending: db.prepare(`
      UPDATE carrier_state SET pending_system = NULL, pending_ts = NULL, pending_uploader = NULL
      WHERE callsign = ?
    `),
  };
}

function close() {
  if (db?.open) db.close();
}

module.exports = {
  open,
  close,
  getChannel: (guildId) => stmts.getChannel.get(guildId)?.channel_id ?? null,
  setChannel: (guildId, channelId) => stmts.setChannel.run(guildId, channelId),

  addTracked: (row) => stmts.addTracked.run(row),
  removeTracked: (guildId, callsign) => stmts.removeTracked.run(guildId, callsign).changes > 0,
  countTracked: (guildId) => stmts.countTracked.get(guildId).n,
  isTracked: (guildId, callsign) => Boolean(stmts.isTracked.get(guildId, callsign)),
  listTracked: (guildId) => stmts.listTracked.all(guildId),
  allTrackedCallsigns: () => stmts.allTrackedCallsigns.all().map((r) => r.callsign),
  guildsTracking: (callsign) => stmts.guildsTracking.all(callsign),
  markFirstSeen: (guildId, callsign) => stmts.markFirstSeen.run(guildId, callsign),

  getState: (callsign) => stmts.getState.get(callsign) ?? null,
  callsignByMarketId: (marketId) => stmts.callsignByMarketId.get(marketId)?.callsign ?? null,
  ensureState: (callsign) => stmts.ensureState.run(callsign),
  setMarketId: (callsign, marketId) => stmts.setMarketId.run(marketId, callsign),
  setPosition: (row) => stmts.setPosition.run(row),
  touch: (row) => stmts.touch.run(row),
  setPending: (row) => stmts.setPending.run(row),
  clearPending: (callsign) => stmts.clearPending.run(callsign),
};
