const SEARCH_URL = 'https://inara.cz/sites/elite/ajaxsearch.php';
const TIMEOUT_MS = 5000;
const MAX_LABEL_LENGTH = 50;

// Inara search values look like "[BAAS] Fortune Hunter (Y7F-70Z) | Sin".
function extractName(value, callsign) {
  if (typeof value !== 'string') return null;
  const end = value.indexOf(` (${callsign})`);
  if (end <= 0) return null;
  return value.slice(0, end).trim().slice(0, MAX_LABEL_LENGTH) || null;
}

async function fetchCarrierName(callsign) {
  const url = `${SEARCH_URL}?${new URLSearchParams({ type: 'GlobalSearch', term: callsign })}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'carrier-tracker-discord-bot', Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const results = await res.json();
    if (!Array.isArray(results)) return null;
    for (const result of results) {
      const name = extractName(result?.value, callsign);
      if (name) return name;
    }
  } catch (err) {
    console.warn(`[inara] name lookup failed for ${callsign}: ${err.message}`);
  }
  return null;
}

module.exports = { fetchCarrierName, extractName };
