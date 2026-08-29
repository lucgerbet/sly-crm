// SLY's standard size chart, and what it says about who actually buys.
//
// Empty by design until Luc fills it in. Every read below degrades to
// "unmatched" rather than guessing a size — a made-up size distribution would
// be worse than an empty one, because it would get acted on.
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import db from '../db.js';
import { MATCHABLE, matchSize, measurementsForOrder, parseRanges } from '../lib/sizeMatch.js';
import { requireIntakeSecret } from '../lib/orderHelpers.js';

const router = Router();

function allStandards() {
  return db.prepare('SELECT * FROM size_standards ORDER BY sort_order ASC, label ASC').all()
    .map((r) => ({ ...r, ranges: parseRanges(r.ranges_json) }));
}

// Only known measurement keys survive, and only as numbers — the chart decides
// sizes, so junk must never reach it.
function cleanRanges(input) {
  const allowed = new Set(MATCHABLE.map((m) => m.key));
  const out = {};
  for (const [key, r] of Object.entries(input || {})) {
    if (!allowed.has(key) || !r || typeof r !== 'object') continue;
    const min = r.min === '' || r.min == null ? null : Number(r.min);
    const max = r.max === '' || r.max == null ? null : Number(r.max);
    const okMin = min == null || Number.isFinite(min);
    const okMax = max == null || Number.isFinite(max);
    if (!okMin || !okMax) continue;
    if (min == null && max == null) continue;
    if (min != null && max != null && min > max) continue;
    out[key] = { min, max };
  }
  return out;
}

// GET /api/sizes — the chart, plus the measurements it may be driven by.
router.get('/', (_req, res) => {
  res.json({ data: allStandards(), matchable: MATCHABLE });
});

// GET /api/sizes/lookup — read-only mirror of the above, for the stylist
// tool's own "consult the size chart" view. Same narrow, secret-gated
// pattern as /api/clients/lookup: this path is reachable without the human
// Basic Auth, so it stays read-only and carries nothing but the chart
// itself (no client data).
router.get('/lookup', requireIntakeSecret, (_req, res) => {
  res.json({ data: allStandards(), matchable: MATCHABLE });
});

router.post('/', (req, res) => {
  const label = (req.body?.label || '').toString().trim();
  if (!label) return res.status(400).json({ error: 'label is required' });
  const id = randomUUID();
  db.prepare(`
    INSERT INTO size_standards (id, label, sort_order, ranges_json, notes)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    id, label,
    Number.isInteger(req.body?.sortOrder) ? req.body.sortOrder : allStandards().length,
    JSON.stringify(cleanRanges(req.body?.ranges)),
    (req.body?.notes || '').toString().trim() || null,
  );
  res.status(201).json({ size: db.prepare('SELECT * FROM size_standards WHERE id = ?').get(id) });
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM size_standards WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const sets = [], vals = [];
  if (req.body?.label !== undefined) {
    const label = (req.body.label || '').toString().trim();
    if (!label) return res.status(400).json({ error: 'label cannot be empty' });
    sets.push('label = ?'); vals.push(label);
  }
  if (req.body?.ranges !== undefined) {
    sets.push('ranges_json = ?'); vals.push(JSON.stringify(cleanRanges(req.body.ranges)));
  }
  if (req.body?.notes !== undefined) {
    sets.push('notes = ?'); vals.push((req.body.notes || '').toString().trim() || null);
  }
  if (req.body?.sortOrder !== undefined) {
    const n = Number.parseInt(req.body.sortOrder, 10);
    if (Number.isInteger(n)) { sets.push('sort_order = ?'); vals.push(n); }
  }
  if (!sets.length) return res.json({ size: existing });

  db.prepare(`UPDATE size_standards SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .run(...vals, req.params.id);
  res.json({ size: db.prepare('SELECT * FROM size_standards WHERE id = ?').get(req.params.id) });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM size_standards WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// GET /api/sizes/distribution — what share of real sales falls on each
// standard size. Counts orders whose deposit actually cleared: a configuration
// someone abandoned before paying says nothing about who buys.
router.get('/distribution', (_req, res) => {
  const standards = allStandards();
  const orders = db.prepare(`
    SELECT o.id, o.order_number, o.product_type, o.config_json, o.shop_config_json,
           c.measurements_json, c.first_name, c.last_name
    FROM orders o JOIN clients c ON c.id = o.client_id
    WHERE o.deposit_status = 'paid'
  `).all();

  const counts = new Map(standards.map((s) => [s.id, { label: s.label, n: 0, exact: 0 }]));
  let unmatched = 0, noMeasurements = 0;

  for (const o of orders) {
    const m = measurementsForOrder({
      configJson: o.config_json,
      shopConfigJson: o.shop_config_json,
      clientMeasurementsJson: o.measurements_json,
    });
    if (!Object.keys(m).length) { noMeasurements += 1; continue; }
    const hit = matchSize(m, standards);
    if (!hit) { unmatched += 1; continue; }
    const row = counts.get(hit.id);
    row.n += 1;
    if (hit.exact) row.exact += 1;
  }

  const matched = [...counts.values()].reduce((a, b) => a + b.n, 0);
  res.json({
    // Order preserved from the chart itself, so 46/48/50 reads as a scale
    // rather than as a leaderboard.
    sizes: [...counts.values()].map((r) => ({
      ...r,
      pct: matched ? Math.round((r.n / matched) * 100) : 0,
    })),
    matched,
    unmatched,
    noMeasurements,
    ordersConsidered: orders.length,
    chartReady: standards.some((s) => Object.keys(s.ranges).length > 0),
  });
});

export default router;
