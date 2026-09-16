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

export function urssafRate() {
  const raw = Number.parseFloat(getSettings().urssaf_percent);
  return Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

// The same Stripe pricing the dashboard applies to real payments — read from
// settings, so the catalogue's estimate and the dashboard's never diverge.
export function stripeFees() {
  const s = getSettings();
  const pct = Number.parseFloat(s.stripe_fee_percent);
  const fixed = Number.parseInt(s.stripe_fee_fixed_cents, 10);
  return {
    pct: Number.isFinite(pct) && pct >= 0 ? pct : 0,
    fixedCents: Number.isFinite(fixed) && fixed >= 0 ? fixed : 0,
  };
}

// Charges = costs of selling, as opposed to costs of making: everything that
// comes off the price rather than going into the piece.
function chargesOn(priceCents, payments, urssafPct, stripe) {
  const urssafCents = Math.round(priceCents * (urssafPct / 100));
  const stripeCents = Math.round(priceCents * (stripe.pct / 100)) + stripe.fixedCents * payments;
  return { urssafCents, stripeCents };
}

// Everything derived hangs off this, so the arithmetic exists exactly once.
//
// A landed cost has four parts: the workshop's base price, a percentage
// surcharge on that base price (the tailored pieces carry 3 %, trousers and
// shirts none), the quality bonus, and a flat export fee paid in euros. The
// first three are in yuan and converted together; the fee is added after.
//
// URSSAF and Stripe are a different animal: shares of the selling price, not
// of the cost, so they are taken off the margin rather than added to the
// landed cost. Stripe's fixed part is charged once per transaction, and a
// deposit-then-balance sale is two of them.
export function withMargin(row, rate = cnyRate(), urssafPct = urssafRate(), stripe = stripeFees()) {
  const cost = Number(row.cost_cny) || 0;
  const bonus = Number(row.bonus_cny) || 0;
  const price = Number(row.price_cents) || 0;
  const surchargePct = Number(row.surcharge_pct) || 0;
  const exportFeeCents = Math.round(Number(row.export_fee_cents)) || 0;
  const surchargeCny = cost * (surchargePct / 100);
  const surchargeCents = Math.round((surchargeCny / rate) * 100);
  const costCents = Math.round(((cost + surchargeCny) / rate) * 100) + exportFeeCents;
  const costWithBonusCents = Math.round(((cost + surchargeCny + bonus) / rate) * 100) + exportFeeCents;
  const payments = Math.max(1, Math.round(Number(row.payments)) || 2);
  const { urssafCents, stripeCents } = chargesOn(price, payments, urssafPct, stripe);
  const marginCents = price - costCents - urssafCents - stripeCents;
  const marginWithBonusCents = price - costWithBonusCents - urssafCents - stripeCents;
  return {
    ...row,
    is_pack: !!row.is_pack,
    on_site: !!row.on_site,
    active: !!row.active,
    surchargeCents,
    exportFeeCents,
    costCents,
    costWithBonusCents,
    payments,
    urssafCents,
    stripeCents,
    // "Sèche" = before the quality bonus. Both are shown because the gap
    // between them is exactly what the bonus costs, and that is a decision
    // Luc revisits. Both are after URSSAF and Stripe.
    marginCents,
    marginWithBonusCents,
    marginPct: price ? Math.round((marginCents / price) * 1000) / 10 : null,
    marginWithBonusPct: price ? Math.round((marginWithBonusCents / price) * 1000) / 10 : null,
  };
}

export function catalogue() {
  const rate = cnyRate(), urssaf = urssafRate(), stripe = stripeFees();
  return db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY sort_order ASC, label ASC')
    .all()
    .map((r) => withMargin(r, rate, urssaf, stripe));
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
  res.json({ data: catalogue(), rate: cnyRate(), urssafPct: urssafRate(), stripe: stripeFees() });
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
    ['surcharge_pct', (v) => Number(v)],
    ['export_fee_cents', (v) => Math.round(Number(v))],
    ['payments', (v) => Math.max(1, Math.round(Number(v)))],
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
