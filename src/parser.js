const CALLSIGN_RE = /^[A-Z0-9]{3}-[A-Z0-9]{3}$/;
const SCHEMA_PREFIX = 'https://eddn.edcd.io/schemas/';

function normalizeCallsign(value) {
  if (typeof value !== 'string') return null;
  const callsign = value.trim().toUpperCase();
  return CALLSIGN_RE.test(callsign) ? callsign : null;
}

function parseTimestamp(value) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Returns the schema name without prefix/version, or null for unknown and /test schemas.
function schemaName(ref) {
  if (typeof ref !== 'string' || !ref.startsWith(SCHEMA_PREFIX)) return null;
  const [name, version, extra] = ref.slice(SCHEMA_PREFIX.length).split('/');
  if (!name || !version || extra !== undefined) return null;
  return name;
}

/**
 * Extracts a fleet carrier sighting from an EDDN envelope.
 * `system` is null for schemas that only link a callsign to a MarketID.
 */
function parseSighting(doc) {
  const schema = schemaName(doc?.$schemaRef);
  const msg = doc?.message;
  if (!schema || !msg || typeof msg !== 'object') return null;

  const base = {
    schema,
    event: null,
    uploader: nonEmpty(doc.header?.uploaderID),
    ts: parseTimestamp(msg.timestamp),
    authoritative: false,
  };
  if (base.ts === null) return null;

  switch (schema) {
    case 'journal': {
      const event = msg.event;
      if (!['Docked', 'Location', 'CarrierJump'].includes(event)) return null;
      if (event !== 'Docked' && msg.Docked !== true) return null;
      if (msg.StationType !== 'FleetCarrier') return null;
      const callsign = normalizeCallsign(msg.StationName);
      const system = nonEmpty(msg.StarSystem);
      if (!callsign || !system) return null;
      return {
        ...base,
        event,
        callsign,
        marketId: Number.isInteger(msg.MarketID) ? msg.MarketID : null,
        system,
        authoritative: event === 'CarrierJump',
      };
    }

    case 'commodity':
    case 'outfitting':
    case 'shipyard': {
      const callsign = normalizeCallsign(msg.stationName);
      const system = nonEmpty(msg.systemName);
      if (!callsign || !system) return null;
      return {
        ...base,
        callsign,
        marketId: Number.isInteger(msg.marketId) ? msg.marketId : null,
        system,
      };
    }

    case 'dockinggranted':
    case 'dockingdenied': {
      if (msg.StationType !== 'FleetCarrier') return null;
      const callsign = normalizeCallsign(msg.StationName);
      if (!callsign || !Number.isInteger(msg.MarketID)) return null;
      return { ...base, event: msg.event ?? null, callsign, marketId: msg.MarketID, system: null };
    }

    case 'fcmaterials_journal':
    case 'fcmaterials_capi': {
      const callsign = normalizeCallsign(msg.CarrierID);
      if (!callsign || !Number.isInteger(msg.MarketID)) return null;
      return { ...base, callsign, marketId: msg.MarketID, system: null };
    }

    default:
      return null;
  }
}

module.exports = { parseSighting, normalizeCallsign, CALLSIGN_RE };
