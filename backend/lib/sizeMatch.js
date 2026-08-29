// Maps a bespoke order's body measurements onto SLY's own standard size chart.
//
// The point is not to tell a client what size they are — they are having a
// suit made precisely so they don't have to be a size. It is to let Luc ask
// "what shape of man actually buys from me", in a vocabulary a fabric supplier
// or a future ready-to-wear run would understand.
//
// Derived on every read rather than stored on the order: the chart will be
// edited, and a stored size would quietly become a lie the moment it is. The
// cost is a recomputation per request over a table of a few dozen sizes, which
// is nothing.

// Measurements the chart may be driven by. Anything not listed is ignored, so
// a typo in a range key can never silently decide a size.
// `body` keys come from the stylist tool's BodyMeasurements; height and weight
// come from the website configurator.
export const MATCHABLE = [
  { key: 'chest', label: 'Poitrine', unit: 'cm' },
  { key: 'waistJacket', label: 'Taille (veste)', unit: 'cm' },
  { key: 'waistPant', label: 'Taille (pantalon)', unit: 'cm' },
  { key: 'shoulder', label: 'Épaules', unit: 'cm' },
  { key: 'hips', label: 'Hanches', unit: 'cm' },
  { key: 'neck', label: 'Cou', unit: 'cm' },
  { key: 'height', label: 'Taille (hauteur)', unit: 'cm' },
  { key: 'weight', label: 'Poids', unit: 'kg' },
];

const MATCHABLE_KEYS = new Set(MATCHABLE.map((m) => m.key));

function num(v) {
  if (v == null || v === '') return null;
  // Measurements arrive as free text ("98", "98 cm", "98,5") — a comma decimal
  // is normal in French and must not parse as 98.
  const n = Number.parseFloat(String(v).replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Pulls the measurable numbers out of an order, wherever they ended up:
// the stylist tool writes body measurements into the order config, while
// height and weight only ever come from the website configurator.
export function measurementsForOrder({ configJson, shopConfigJson, clientMeasurementsJson }) {
  const parse = (raw) => { try { return JSON.parse(raw || '{}'); } catch { return {}; } };
  const config = parse(configJson);
  const shop = parse(shopConfigJson);
  const client = parse(clientMeasurementsJson);

  // Order-level first: it is what was measured for this piece. The client-level
  // snapshot is the fallback for orders taken before a measurement step existed.
  const body = { ...(client.bodyMeasurements || {}), ...(config.bodyMeasurements || {}) };

  const out = {};
  for (const key of MATCHABLE_KEYS) {
    const v = num(body[key] ?? shop[key]);
    if (v != null) out[key] = v;
  }
  return out;
}

// Parses one chart row's ranges, dropping anything malformed rather than
// letting it participate in a match it would decide wrongly.
export function parseRanges(rangesJson) {
  let raw;
  try { raw = JSON.parse(rangesJson || '{}'); } catch { return {}; }
  const out = {};
  for (const [key, r] of Object.entries(raw || {})) {
    if (!MATCHABLE_KEYS.has(key) || !r || typeof r !== 'object') continue;
    const min = num(r.min);
    const max = num(r.max);
    if (min == null && max == null) continue;
    if (min != null && max != null && min > max) continue;
    out[key] = { min, max };
  }
  return out;
}

function distanceOutside(value, { min, max }) {
  if (min != null && value < min) return min - value;
  if (max != null && value > max) return value - max;
  return 0;
}

// Returns the best-fitting size, or null when nothing can honestly be said.
//
// Scoring is deliberately blunt: the size that satisfies the most of its own
// ranges wins, ties broken by how far outside the rest it falls. A cleverer
// weighting would be inventing precision the chart doesn't carry.
export function matchSize(measurements, standards) {
  if (!measurements || !standards?.length) return null;

  let best = null;
  for (const std of standards) {
    const ranges = std.ranges && typeof std.ranges === 'object' ? std.ranges : parseRanges(std.ranges_json);
    const keys = Object.keys(ranges);
    if (!keys.length) continue;

    let comparable = 0, inRange = 0, drift = 0;
    for (const key of keys) {
      const value = measurements[key];
      if (value == null) continue;
      comparable += 1;
      const d = distanceOutside(value, ranges[key]);
      if (d === 0) inRange += 1; else drift += d;
    }
    // A size we cannot compare on any measurement is not a candidate — it is
    // an absence of information, not a bad fit.
    if (!comparable) continue;

    const candidate = { label: std.label, id: std.id, comparable, inRange, drift };
    if (!best
      || candidate.inRange > best.inRange
      || (candidate.inRange === best.inRange && candidate.drift < best.drift)) {
      best = candidate;
    }
  }

  if (!best) return null;
  return {
    ...best,
    // An exact match satisfies every range it could be compared on. Anything
    // less is the closest row, and the UI must be able to say so.
    exact: best.inRange === best.comparable,
  };
}
