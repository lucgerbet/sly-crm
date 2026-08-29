// The catalogue and what each line of it earns.
//
// One place decides what SLY sells, what it costs and what it is worth — so a
// margin on the dashboard, a cost on an order and a price in a pack can never
// come from three different sets of numbers.
//
// Costs are held in yuan (the workshop's currency) and converted on read at
// settings.cny_per_eur. Converting on entry would bake a rate into the data
// and silently falsify every past margin the day the rate moves.
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import db from '../db.js';
import { getSettings } from './settings.js';
import { requireIntakeSecret } from '../lib/orderHelpers.js';

const router = Router();

export function cnyRate() {
  const raw = Number.parseFloat(getSettings().cny_per_eur);
  // A rate of zero or nonsense would turn every cost into Infinity, which is
  // worse than being slightly out of date.
  return Number.isFinite(raw) && raw > 0 ? raw : 7.8;
}

// Everything derived hangs off this, so the arithmetic exists exactly once.
export function withMargin(row, rate = cnyRate()) {
  const cost = Number(row.cost_cny) || 0;
  const bonus = Number(row.bonus_cny) || 0;
  const price = Number(row.price_cents) || 0;
  const costCents = Math.round((cost / rate) * 100);
  const costWithBonusCents = Math.round(((cost + bonus) / rate) * 100);
  return {
    ...row,
    is_pack: !!row.is_pack,
    on_site: !!row.on_site,
    active: !!row.active,
    costCents,
    costWithBonusCents,
    // "Sèche" = before the quality bonus. Both are shown because the gap
    // between them is exactly what the bonus costs, and that is a decision
    // Luc revisits.
    marginCents: price - costCents,
    marginWithBonusCents: price - costWithBonusCents,
    marginPct: price ? Math.round(((price - costCents) / price) * 1000) / 10 : null,
    marginWithBonusPct: price ? Math.round(((price - costWithBonusCents) / price) * 1000) / 10 : null,
  };
}

export function catalogue() {
  const rate = cnyRate();
  return db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY sort_order ASC, label ASC')
    .all()
    .map((r) => withMargin(r, rate));
}

// Looks a product up by the key an order carries in product_type. Returns the
// cost Luc actually bears, bonus included.
export function productCostCents(productType) {
  if (!productType) return null;
  const row = db.prepare('SELECT * FROM products WHERE key = ? AND active = 1').get(productType);
  if (!row || row.cost_cny == null) return null;
  return withMargin(row).costWithBonusCents;
}

router.get('/', (_req, res) => {
  res.json({ data: catalogue(), rate: cnyRate() });
});

// GET /api/products/on-site — what sly-shop is allowed to offer. Narrow and
// secret-gated like the other server-to-server reads: it carries prices, not
// costs, because a shop has no business knowing what a piece costs to make.
router.get('/on-site', requireIntakeSecret, (_req, res) => {
  res.json({
    data: catalogue()
      .filter((p) => p.on_site)
      .map((p) => ({ key: p.key, label: p.label, priceCents: p.price_cents, isPack: p.is_pack })),
  });
});

function clean(body, existing = {}) {
  const out = {};
  if (body.label !== undefined) {
    const label = String(body.label || '').trim();
    if (label) out.label = label;
  }
  for (const [field, parse] of [
    ['price_cents', (v) => Math.round(Number(v))],
    ['cost_cny', (v) => Number(v)],
    ['bonus_cny', (v) => Number(v)],
    ['sort_order', (v) => Math.round(Number(v))],
  ]) {
    if (body[field] === undefined) continue;
    if (body[field] === '' || body[field] === null) { out[field] = null; continue; }
    const n = parse(body[field]);
    // Junk is dropped rather than stored: these numbers decide every margin
    // in the CRM, so a NaN here would spread silently.
    if (Number.isFinite(n) && n >= 0) out[field] = n;
  }
  for (const flag of ['is_pack', 'on_site', 'active']) {
    if (body[flag] !== undefined) out[flag] = body[flag] ? 1 : 0;
  }
  if (body.notes !== undefined) out.notes = String(body.notes || '').trim() || null;
  return out;
}

router.post('/', (req, res) => {
  const key = String(req.body?.key || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (!key) return res.status(400).json({ error: 'key is required' });
  if (db.prepare('SELECT 1 FROM products WHERE key = ?').get(key)) {
    return res.status(409).json({ error: 'Ce code produit existe déjà' });
  }
  const fields = clean(req.body);
  if (!fields.label) return res.status(400).json({ error: 'label is required' });

  const id = randomBytes(16).toString('hex');
  const cols = ['id', 'key', ...Object.keys(fields)];
  db.prepare(`INSERT INTO products (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(id, key, ...Object.values(fields));
  res.status(201).json({ product: withMargin(db.prepare('SELECT * FROM products WHERE id = ?').get(id)) });
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const fields = clean(req.body, existing);
  if (!Object.keys(fields).length) return res.json({ product: withMargin(existing) });

  db.prepare(`UPDATE products SET ${Object.keys(fields).map((f) => `${f} = ?`).join(', ')},
    updated_at = datetime('now') WHERE id = ?`).run(...Object.values(fields), req.params.id);
  res.json({ product: withMargin(db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id)) });
});

// Deactivated, never deleted: an order placed last month still refers to it,
// and a catalogue row that vanishes takes that order's cost with it.
router.delete('/:id', (req, res) => {
  db.prepare("UPDATE products SET active = 0, updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

export default router;
