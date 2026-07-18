const router = require('express').Router();
const { auth } = require('./auth');

// Only allow fetching from known, trusted rental-listing domains — this
// endpoint fetches arbitrary URLs server-side, so an allowlist prevents it
// being used as an open proxy (SSRF risk) for internal or unrelated sites.
const ALLOWED_HOSTS = ['toprent.ua', 'www.toprent.ua'];

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Tier labels as they appear across the site's UK/RU/EN locales.
const TIER_PATTERNS = [
  { key: '30+', re: /30\+\s*(?:днів|дней|days)?/i },
  { key: '10-29', re: /10\s*-\s*29\s*(?:днів|дней|days)?/i },
  { key: '4-9', re: /4\s*-\s*9\s*(?:днів|дней|days)?/i },
  { key: '2-3', re: /2\s*-\s*3\s*(?:дні|дня|days)?/i },
];
const DEPOSIT_RE = /(застава|залог|deposit)/i;

function extractNumberAfter(text, index, maxLookAhead = 40) {
  const window = text.slice(index, index + maxLookAhead);
  const m = window.match(/(\d[\d\s]{0,6}\d|\d)/);
  return m ? parseInt(m[1].replace(/\s/g, ''), 10) : null;
}

function extractTiers(text) {
  const tiers = [];
  for (const { key, re } of TIER_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const usd = extractNumberAfter(text, m.index + m[0].length);
    if (usd) tiers.push({ label: key, usd });
  }
  let deposit = null;
  const dm = DEPOSIT_RE.exec(text);
  if (dm) deposit = extractNumberAfter(text, dm.index + dm[0].length);
  return { tiers, deposit };
}

const SPEC_PATTERNS = {
  bodyType: /(хетчбек|hatchback|седан|sedan|позашляховик|suv|кросовер|crossover|мінівен|minivan|кабріолет|cabrio|універсал|wagon|купе|coupe)/i,
  engine: /(\d[.,]\d)\s*l\b/i,
  power: /\((\d{2,3})\s*(?:h\.?\s*p\.?|к\.?\s*с\.?)\)/i,
  transmission: /(автомат|automatic|механік|manual)/i,
  drive: /(передній|передн|front-wheel|повний|4x4|4wd|full drive|задній|rear-wheel)/i,
  fuel: /(бензин|petrol|дизель|diesel|електро|electric|газ|lpg)/i,
  consumption: /(\d[.,]\d)\s*(?:l\/100\s*km|л\/100\s*км)/i,
  climate: /(клімат|climate control|кондиціонер)/i,
};

function extractSpecs(text) {
  const specs = {};
  for (const [key, re] of Object.entries(SPEC_PATTERNS)) {
    const m = re.exec(text);
    if (!m) continue;
    // engine/power/consumption feed plain numeric text fields — extract just
    // the captured number/group rather than the whole matched phrase.
    if ((key === 'engine' || key === 'power' || key === 'consumption') && m[1]) {
      specs[key] = m[1].replace(',', '.');
    } else {
      specs[key] = m[0].trim();
    }
  }
  return specs;
}

router.get('/', auth, async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'Invalid url' }); }
  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    return res.status(400).json({ error: 'Host not allowed' });
  }

  try {
    const r = await fetch(parsed.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AV_fleetOS price-check)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return res.status(502).json({ error: 'Upstream fetch failed', status: r.status });
    const html = await r.text();
    const text = stripTags(html);
    const { tiers, deposit } = extractTiers(text);
    const specs = extractSpecs(text);
    res.json({ tiers, deposit, specs });
  } catch (err) {
    res.status(502).json({ error: 'Fetch error', message: String(err.message || err) });
  }
});

module.exports = router;
