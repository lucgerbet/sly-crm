import { Router } from 'express';
import db from '../db.js';
import { getSettings } from './settings.js';

const router = Router();

const EFF_TIMING = `
  CASE
    WHEN target_contact_date IS NULL THEN NULL
    WHEN date(target_contact_date) <= date('now') THEN 'now'
    WHEN julianday(target_contact_date) <= julianday('now','+31 days') THEN '1month'
    WHEN julianday(target_contact_date) <= julianday('now','+92 days') THEN '3months'
    ELSE '6months'
  END`;

router.get('/stats', (_req, res) => {
  const c = (sql) => db.prepare(`SELECT COUNT(*) AS n FROM clients WHERE ${sql}`).get().n;

  const total     = db.prepare('SELECT COUNT(*) AS n FROM clients').get().n;
  const contCount = c('contacted = 1');
  const repCount  = c('answered = 1');
  const rdvCount  = c('appointment = 1');
  const wonCount  = c('won = 1');
  const lostCount = c('lost = 1');

  // Real money, from orders Stripe has confirmed — not clients.ca_lifetime,
  // which is typed by hand and was silently showing a different (usually
  // emptier) number than the business had actually taken. Only cleared
  // amounts count: an invoiced-but-unpaid balance is not revenue.
  // Returned in whole euros to match what this endpoint already promised its
  // callers, while the amounts themselves are stored in cents.
  const revenue = Math.round(db.prepare(`
    SELECT COALESCE(SUM(
      CASE WHEN deposit_status = 'paid' THEN deposit_amount_cents ELSE 0 END +
      CASE WHEN balance_status = 'paid' THEN balance_amount_cents ELSE 0 END
    ), 0) AS n FROM orders
  `).get().n / 100);

  // Average basket only over orders whose total is actually settled — a
  // deposit-only order has no agreed total yet and would drag the mean down.
  const settled = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(deposit_amount_cents + balance_amount_cents),0) AS cents
    FROM orders WHERE deposit_status = 'paid' AND balance_status = 'paid'
  `).get();
  const panierMoy = settled.n > 0 ? Math.round(settled.cents / settled.n / 100) : 0;
  const tauxConv  = contCount > 0 ? Math.round((wonCount / contCount) * 100) : 0;
  const tauxRep   = contCount > 0 ? Math.round((repCount / contCount) * 100) : 0;

  const byTiming = db.prepare(`
    SELECT eff AS timing, COUNT(*) AS n FROM (
      SELECT (${EFF_TIMING}) AS eff FROM clients WHERE target_contact_date IS NOT NULL AND lost = 0
    ) GROUP BY eff
  `).all();

  const byPotential = db.prepare(`
    SELECT potential, COUNT(*) AS n FROM clients
    WHERE potential IS NOT NULL AND potential != '' GROUP BY potential
  `).all();

  const settings = getSettings();

  let daysLeft = null;
  if (settings.campaign_deadline) {
    const r = db.prepare("SELECT CAST(julianday(?) - julianday('now') AS INTEGER) AS d").get(settings.campaign_deadline);
    daysLeft = r.d;
  }

  res.json({
    pipeline: { total, contCount, repCount, rdvCount, wonCount, lostCount },
    metrics: { revenue, panierMoy, tauxConv, tauxRep },
    byTiming,
    byPotential,
    settings,
    daysLeft,
  });
});

// GET /api/regions — where the clients actually are.
//
// The raw data is typed by hand and by Stripe, so it arrives inconsistent:
// "Nimes", "Nîmes " and "nimes" are one city, and counting them as three would
// make every regional read useless. Grouping is done on an accent- and
// case-folded key, while the label shown is the spelling that appears most
// often — normalise for counting, never for display.
//
// Nothing is invented: a client with no location is counted as unknown and
// reported, rather than quietly dropped so the percentages look complete.
const COUNTRY_NAMES = {
  // The countries sly-shop allows at checkout, so a bare Stripe country code
  // reads as a country rather than as two letters.
  FR: 'France', BE: 'Belgique', CH: 'Suisse', LU: 'Luxembourg', MC: 'Monaco',
  DE: 'Allemagne', GB: 'Royaume-Uni', US: 'États-Unis', CA: 'Canada',
};

function foldKey(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// Pulls a city and country out of a free-text address. Used only to fill a
// gap, never to override a value someone typed.
//
// Addresses reach the CRM in several shapes and the naive "second-to-last
// segment is the city" rule broke on the first one that carried a region:
// "…, 30230 Bouillargues, Occitanie, FR" reported Occitanie as a city. The
// postcode is the reliable marker of where the city actually sits.
function fromAddress(address) {
  const parts = String(address || '').split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return {};

  let rest = parts;
  let country = null;
  const tail = parts[parts.length - 1];
  if (/^[A-Za-z]{2}$/.test(tail)) {
    country = COUNTRY_NAMES[tail.toUpperCase()] || tail.toUpperCase();
    rest = parts.slice(0, -1);
  }

  let city = null;
  // "30230 Bouillargues" — postcode and city in one segment. Read from the
  // end, so a street number never gets mistaken for a postcode.
  for (let i = rest.length - 1; i >= 0 && !city; i -= 1) {
    const m = rest[i].match(/^\d{4,6}\s+(.+)$/);
    if (m) city = m[1].trim();
  }
  // "50 rue Pierre Semard, 30000, Nîmes" — postcode alone, city next.
  for (let i = 0; i < rest.length - 1 && !city; i += 1) {
    if (/^\d{4,6}$/.test(rest[i])) city = rest[i + 1].trim();
  }
  // Nothing postcode-shaped: fall back to the last segment, which is the best
  // guess left rather than a confident one.
  if (!city) city = rest[rest.length - 1] || null;

  return { city: city || null, country };
}

function tally(rows, pick) {
  const groups = new Map();
  // "Unknown" covers two very different situations and they must not be one
  // number: a lead who only ever left an email has no address to know, while
  // a paying client with no address is a genuine gap in the record.
  let unknown = 0, unknownBuyers = 0;
  for (const r of rows) {
    const raw = pick(r);
    const key = foldKey(raw);
    if (!key) {
      unknown += 1;
      if (r.is_buyer) unknownBuyers += 1;
      continue;
    }
    if (!groups.has(key)) groups.set(key, { labels: new Map(), n: 0, buyers: 0 });
    const g = groups.get(key);
    const label = String(raw).replace(/\s+/g, ' ').trim();
    g.labels.set(label, (g.labels.get(label) || 0) + 1);
    g.n += 1;
    if (r.is_buyer) g.buyers += 1;
  }
  const total = rows.length;
  return {
    rows: [...groups.values()]
      .map((g) => ({
        // The spelling seen most often wins, so the display stays something a
        // human wrote rather than a folded key.
        label: [...g.labels.entries()].sort((a, b) => b[1] - a[1])[0][0],
        n: g.n,
        buyers: g.buyers,
        pct: total ? Math.round((g.n / total) * 100) : 0,
      }))
      .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)),
    unknown,
    unknownBuyers,
  };
}

router.get('/regions', (_req, res) => {
  const clients = db.prepare(`
    SELECT c.id, c.city, c.country, c.address,
           EXISTS (SELECT 1 FROM orders o WHERE o.client_id = c.id AND o.deposit_status = 'paid') AS is_buyer
    FROM clients c
  `).all();

  const enriched = clients.map((c) => {
    const guess = (c.city && c.country) ? {} : fromAddress(c.address);
    return { ...c, city: c.city || guess.city || null, country: c.country || guess.country || null };
  });

  res.json({
    total: enriched.length,
    buyers: enriched.filter((c) => c.is_buyer).length,
    countries: tally(enriched, (c) => c.country),
    cities: tally(enriched, (c) => c.city),
  });
});

export default router;
