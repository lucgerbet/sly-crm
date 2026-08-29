import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import db from '../db.js';
import { requireIntakeSecret, snapshotClientMeasurements } from '../lib/orderHelpers.js';
import { getSettings } from './settings.js';

const router = Router();

const CLIENT_FIELDS = [
  'first_name','last_name','phone','email','city','country','address','source','tags','notes',
  'birth_date','email_opt_out','tape_measure_sent_at','needs_tape_measure','physical_prospect',
  'next_step','last_contacted_date','target_contact_date',
  'ca_lifetime','purchase_count','last_purchase_date','last_purchase_item',
  'assigned_to','potential',
  'contacted','answered','appointment','appointment_date','appointment_time','appointment_location','won',
  'lost','lost_reason',
  // Discovery profile — captured in the meeting, editable here afterwards.
  'profession','company','job_title','sector',
  'suit_frequency','travel_frequency','wardrobe_size',
  'style_direction','style_reference','interests','rtw_frustrations','rtw_frustrations_note',
  'nationality','made_to_measure_reason','made_to_measure_reason_note',
  'next_event_type','next_event_date','referral_interest','referral_names',
  'recontact_events','recontact_new_piece','recontact_seasonal',
];

// Subset writable by the stylist tool via the shared intake secret (see
// set-profile below). Same narrowing rationale as set-address: this path is
// reachable without the human Basic Auth, so it must never expose pipeline
// flags, lifetime value or ownership — only what a discovery conversation
// legitimately produces.
const PROFILE_FIELDS = [
  'birth_date','address','city','country','source','nationality',
  'profession','company','job_title','sector',
  'suit_frequency','travel_frequency','wardrobe_size',
  'style_direction','style_reference','interests','rtw_frustrations','rtw_frustrations_note',
  'made_to_measure_reason','made_to_measure_reason_note',
  'next_event_type','next_event_date','referral_interest','referral_names',
  'recontact_events','recontact_new_piece','recontact_seasonal',
];

// SQL expression: effective timing derived from target_contact_date vs now
const EFF_TIMING = `
  CASE
    WHEN target_contact_date IS NULL THEN NULL
    WHEN date(target_contact_date) <= date('now') THEN 'now'
    WHEN julianday(target_contact_date) <= julianday('now','+31 days') THEN '1month'
    WHEN julianday(target_contact_date) <= julianday('now','+92 days') THEN '3months'
    ELSE '6months'
  END`;

// Computed, never stored — a "client" is whoever has at least one order with
// a paid deposit, full stop. Deliberately NOT derived from the `won` pipeline
// flag: that's a manual outreach-tracking checkbox Luc may never get around
// to ticking for someone who converts straight through the website, so it
// can't be trusted as "has this person actually paid". physical_prospect is
// the one thing that can't be inferred from any other data — whether the
// email was collected in person (networking) rather than through the
// site's own lead capture / checkout, so it stays a manual flag.
const CONTACT_TYPE = `
  CASE
    WHEN EXISTS (SELECT 1 FROM orders o WHERE o.client_id = clients.id AND o.deposit_status = 'paid') THEN 'client'
    WHEN physical_prospect = 1 THEN 'prospect_physical'
    ELSE 'prospect_online'
  END`;

// Sequential pipeline: each step requires the previous one to already be true.
const STAGE_FLAGS = ['contacted','answered','appointment','won'];
const STAGE_PREREQ = { answered: 'contacted', appointment: 'answered', won: 'appointment' };

// What a client has actually paid SLY, in euros, summed from Stripe-confirmed
// payments. Derived on read rather than stored: the old `ca_lifetime` column
// was typed by hand, so it read 0 for every real client — a client's value is
// a fact about their payments, not a field someone has to remember to update.
//
// `ca_lifetime` survives only as a fallback for someone with no orders at all
// (a client from before the CRM existed, entered by hand). The moment a real
// payment lands, the real figure wins.
const LIFETIME_VALUE = `
  COALESCE(
    NULLIF((
      SELECT SUM(
        CASE WHEN o.deposit_status = 'paid' THEN COALESCE(o.deposit_amount_cents, 0) ELSE 0 END +
        CASE WHEN o.balance_status = 'paid' THEN COALESCE(o.balance_amount_cents, 0) ELSE 0 END
      ) FROM orders o WHERE o.client_id = clients.id
    ), 0) / 100.0,
    clients.ca_lifetime,
    0
  )`;

// Same reasoning for the two other commercial facts the list shows.
const ORDER_COUNT = `
  (SELECT COUNT(*) FROM orders o WHERE o.client_id = clients.id AND o.deposit_status = 'paid')`;
const LAST_PURCHASE = `
  COALESCE(
    (SELECT MAX(o.deposit_paid_at) FROM orders o
      WHERE o.client_id = clients.id AND o.deposit_status = 'paid'),
    clients.last_purchase_date
  )`;

// Lifetime-value tiers. Generic thresholds for a brand starting from zero —
// edit here (and in frontend/src/labels.js VALUE_TIERS) once real numbers are known.
// Expressed against the derived value, so a tier can never disagree with the
// revenue printed next to it.
const VALUE_TIER_SQL = {
  bronze:   `(${LIFETIME_VALUE}) < 500`,
  silver:   `(${LIFETIME_VALUE}) >= 500 AND (${LIFETIME_VALUE}) < 2000`,
  gold:     `(${LIFETIME_VALUE}) >= 2000 AND (${LIFETIME_VALUE}) < 5000`,
  platinum: `(${LIFETIME_VALUE}) >= 5000`,
};

// POST /api/clients/set-address — called by the stylist tool (server-to-
// server, via SLY_INTAKE_SECRET) so the delivery address captured live in a
// meeting reaches the CRM's clients.address column (also used by the
// tape-measure-shipping flow, and printed on the production order PDF — see
// lib/pdf.js). Narrow on purpose: unlike PUT /:id below (human-authenticated
// only, behind Traefik Basic Auth), this is reachable with just the shared
// intake secret, so it only ever touches this one field, not the full
// CLIENT_FIELDS surface. clientId in the body, not the URL, so the Traefik
// public-router allowlist can match this exact static path.
router.post('/set-address', requireIntakeSecret, (req, res) => {
  const { clientId, address } = req.body || {};
  if (!clientId) return res.status(400).json({ error: 'clientId is required' });
  const existing = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
  if (!existing) return res.status(404).json({ error: 'Client not found' });
  db.prepare('UPDATE clients SET address = ? WHERE id = ?').run(address || null, clientId);
  res.json({ ok: true });
});

// POST /api/clients/set-profile — called by the stylist tool as the Discovery
// step is filled in, not only at /orders/finalize (which never fires at all
// for a meeting closed before the payment step, and would lose everything the
// client just told you). Same narrow, secret-only pattern as set-address:
// restricted to PROFILE_FIELDS, clientId in the body so Traefik's public
// allowlist can match a static path. Partial by design — the stylist fills
// this in across the whole meeting, so only the keys actually present are
// written and a later call never blanks an earlier one.
router.post('/set-profile', requireIntakeSecret, (req, res) => {
  const { clientId, profile } = req.body || {};
  if (!clientId) return res.status(400).json({ error: 'clientId is required' });
  if (!profile || typeof profile !== 'object') {
    return res.status(400).json({ error: 'profile is required' });
  }
  const existing = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
  if (!existing) return res.status(404).json({ error: 'Client not found' });

  const fields = PROFILE_FIELDS.filter((f) => profile[f] !== undefined);
  if (!fields.length) return res.json({ ok: true, skipped: 'no profile fields' });

  // Array-valued tags (interests, rtw_frustrations) are stored as JSON text.
  const value = (f) => {
    const v = profile[f];
    if (Array.isArray(v)) return JSON.stringify(v);
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v === '' ? null : v;
  };

  db.prepare(
    `UPDATE clients SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`
  ).run(...fields.map(value), clientId);

  res.json({ ok: true, updated: fields.length });
});

// POST /api/clients/set-measurements — called automatically by the stylist
// tool as soon as the Measurements step is filled in and left, not only at
// /orders/finalize (which only fires later, tied to the balance-payment
// button, and never at all for a meeting closed before reaching it). Same
// narrow, secret-only pattern as set-address above — this is the ONLY other
// writer of clients.measurements_json besides /orders/finalize's own
// snapshot, and both use the exact same shape.
router.post('/set-measurements', requireIntakeSecret, (req, res) => {
  const { clientId, orderId, measurements } = req.body || {};
  if (!clientId) return res.status(400).json({ error: 'clientId is required' });
  if (!measurements || typeof measurements !== 'object') {
    return res.status(400).json({ error: 'measurements is required' });
  }
  const existing = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
  if (!existing) return res.status(404).json({ error: 'Client not found' });

  const wrote = snapshotClientMeasurements(clientId, orderId, measurements);
  res.json({ ok: true, skipped: wrote ? undefined : 'no measurement data' });
});

// GET /api/clients/lookup?q= — powers the "who referred them" picker in the
// stylist tool's Discovery step. Same narrow, secret-only pattern as the
// other set-*/lookup routes: name only, nothing else, so this reachable-
// without-Basic-Auth path can never leak email/phone/pipeline data.
router.get('/lookup', requireIntakeSecret, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ data: [] });
  const rows = db.prepare(
    `SELECT id, first_name, last_name FROM clients
     WHERE (first_name || ' ' || last_name) LIKE ?
     ORDER BY first_name, last_name LIMIT 15`
  ).all(`%${q}%`);
  res.json({ data: rows.map((r) => ({ id: r.id, firstName: r.first_name, lastName: r.last_name })) });
});

router.get('/', (req, res) => {
  const { q, timing, stage, valueTier, assignedTo, contactType } = req.query;
  let sql = `SELECT *, (${EFF_TIMING}) AS eff_timing, (${CONTACT_TYPE}) AS contact_type,
          (${LIFETIME_VALUE}) AS lifetime_value, (${ORDER_COUNT}) AS order_count,
          (${LAST_PURCHASE}) AS last_purchase_at FROM clients WHERE 1=1`;
  const params = [];

  if (q) {
    sql += ' AND (first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR phone LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (timing) {
    sql += ` AND (${EFF_TIMING}) = ?`;
    params.push(timing);
  }
  if (stage === 'contacted') sql += ' AND contacted = 1';
  else if (stage === 'answered') sql += ' AND answered = 1';
  else if (stage === 'appointment') sql += ' AND appointment = 1';
  else if (stage === 'won') sql += ' AND won = 1';
  else if (stage === 'lost') sql += ' AND lost = 1';
  else if (stage === 'new') sql += ' AND contacted = 0 AND lost = 0';

  if (VALUE_TIER_SQL[valueTier]) sql += ` AND (${VALUE_TIER_SQL[valueTier]})`;

  // 'prospect' means "anyone who hasn't bought", whichever way their details
  // were collected. The two prospect flavours stay separately filterable.
  if (contactType === 'prospect') {
    sql += ` AND (${CONTACT_TYPE}) != 'client'`;
  } else if (contactType) {
    sql += ` AND (${CONTACT_TYPE}) = ?`;
    params.push(contactType);
  }

  if (assignedTo === '__unassigned__') sql += " AND (assigned_to IS NULL OR assigned_to = '')";
  else if (assignedTo) { sql += ' AND assigned_to = ?'; params.push(assignedTo); }

  sql += ' ORDER BY created_at DESC';

  const rows = db.prepare(sql).all(...params);
  res.json({ data: rows, total: rows.length });
});

// Distinct list of people already used as an owner (for the picker/filter)
router.get('/assignees', (_req, res) => {
  const rows = db.prepare(
    "SELECT DISTINCT assigned_to FROM clients WHERE assigned_to IS NOT NULL AND assigned_to != '' ORDER BY assigned_to"
  ).all();
  res.json({ data: rows.map(r => r.assigned_to) });
});

// GET /api/clients/tape-queue — who is waiting on a measuring tape, with the
// address ready to copy. The alert email fires once at deposit time; this is
// the standing list, so a mail read on the phone and forgotten doesn't mean a
// client turns up to the fitting unable to measure himself.
// Deposit-paid only: a tape posted before the client has actually paid is a
// tape given away.
router.get('/tape-queue', (_req, res) => {
  const rows = db.prepare(`
    SELECT DISTINCT c.id, c.first_name, c.last_name, c.email, c.phone, c.address,
           c.needs_tape_measure, c.tape_measure_sent_at,
           MIN(o.created_at) AS first_paid_order_at
    FROM clients c
    JOIN orders o ON o.client_id = c.id AND o.deposit_status = 'paid'
    WHERE c.needs_tape_measure = 1 AND c.tape_measure_sent_at IS NULL
    GROUP BY c.id
    ORDER BY first_paid_order_at ASC
  `).all();
  // Shipped with the queue rather than fetched separately: the link is only
  // ever used from these rows, and one request means the button can't render
  // a beat after the list it belongs to.
  res.json({ data: rows, productUrl: getSettings().tape_measure_product_url || '' });
});

router.get('/:id', (req, res) => {
  const row = db.prepare(`SELECT *, (${EFF_TIMING}) AS eff_timing, (${CONTACT_TYPE}) AS contact_type,
          (${LIFETIME_VALUE}) AS lifetime_value, (${ORDER_COUNT}) AS order_count,
          (${LAST_PURCHASE}) AS last_purchase_at FROM clients WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Client not found' });
  res.json(row);
});

// GET /api/clients/:id/feedback — every end-of-meeting debrief this client has
// given, newest first. Human-authenticated like the rest of the CRM UI.
router.get('/:id/feedback', (req, res) => {
  const rows = db.prepare(`
    SELECT f.*, o.order_number
    FROM order_feedback f
    LEFT JOIN orders o ON o.id = f.order_id
    WHERE f.client_id = ?
    ORDER BY f.created_at DESC
  `).all(req.params.id);
  // Only answered surveys — an unopened one is noise, and the fact it was
  // sent is already visible from the order's payment history.
  const surveys = db.prepare(`
    SELECT s.*, o.order_number
    FROM satisfaction_surveys s
    LEFT JOIN orders o ON o.id = s.order_id
    WHERE s.client_id = ? AND s.submitted_at IS NOT NULL
    ORDER BY s.submitted_at DESC
  `).all(req.params.id);
  res.json({ data: rows, surveys });
});

router.post('/', (req, res) => {
  const id = randomUUID();
  const fields = CLIENT_FIELDS.filter(f => req.body[f] !== undefined);
  if (!fields.length) return res.status(400).json({ error: 'No fields provided' });

  const extraCols = [];
  const extraVals = [];
  for (const flag of STAGE_FLAGS) {
    if (req.body[flag]) { extraCols.push(`${flag}_at`); extraVals.push(new Date().toISOString()); }
  }

  const cols = ['id', ...fields, ...extraCols].join(', ');
  const placeholders = Array(fields.length + 1 + extraCols.length).fill('?').join(', ');
  const values = [id, ...fields.map(f => req.body[f] ?? null), ...extraVals];

  db.prepare(`INSERT INTO clients (${cols}) VALUES (${placeholders})`).run(...values);
  const created = db.prepare(`SELECT *, (${EFF_TIMING}) AS eff_timing, (${CONTACT_TYPE}) AS contact_type,
          (${LIFETIME_VALUE}) AS lifetime_value, (${ORDER_COUNT}) AS order_count,
          (${LAST_PURCHASE}) AS last_purchase_at FROM clients WHERE id = ?`).get(id);
  res.status(201).json(created);
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Client not found' });

  const fields = CLIENT_FIELDS.filter(f => req.body[f] !== undefined);
  if (!fields.length) return res.status(400).json({ error: 'No fields provided' });

  // Enforce the sequential chain. Turning a step OFF is always allowed (no cascade).
  for (const flag of STAGE_FLAGS) {
    if (req.body[flag] === undefined) continue;
    const next = req.body[flag] ? 1 : 0;
    const prev = existing[flag] ? 1 : 0;
    if (next !== 1 || prev !== 0) continue;

    const prereq = STAGE_PREREQ[flag];
    const prereqVal = prereq ? (req.body[prereq] !== undefined ? req.body[prereq] : existing[prereq]) : 1;
    if (prereq && !prereqVal) {
      return res.status(400).json({ error: `Complete "${prereq}" before marking "${flag}" done.` });
    }
  }

  const setClauses = fields.map(f => `${f} = ?`);
  const values = fields.map(f => req.body[f] ?? null);

  // Maintain stage timestamps on 0->1 / 1->0 transitions.
  for (const flag of STAGE_FLAGS) {
    if (req.body[flag] === undefined) continue;
    const next = req.body[flag] ? 1 : 0;
    const prev = existing[flag] ? 1 : 0;
    if (next === 1 && prev === 0) {
      setClauses.push(`${flag}_at = ?`); values.push(new Date().toISOString());
      if (flag === 'contacted' && req.body.last_contacted_date === undefined && !existing.last_contacted_date) {
        setClauses.push('last_contacted_date = ?'); values.push(new Date().toISOString().slice(0, 10));
      }
    } else if (next === 0 && prev === 1) {
      setClauses.push(`${flag}_at = ?`); values.push(null);
    }
  }

  if (req.body.lost !== undefined) {
    const next = req.body.lost ? 1 : 0;
    const prev = existing.lost ? 1 : 0;
    if (next === 1 && prev === 0) { setClauses.push('lost_at = ?'); values.push(new Date().toISOString()); }
    else if (next === 0 && prev === 1) { setClauses.push('lost_at = ?'); values.push(null); }
  }

  setClauses.push("updated_at = datetime('now')");
  values.push(req.params.id);

  db.prepare(`UPDATE clients SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);

  const updated = db.prepare(`SELECT *, (${EFF_TIMING}) AS eff_timing, (${CONTACT_TYPE}) AS contact_type,
          (${LIFETIME_VALUE}) AS lifetime_value, (${ORDER_COUNT}) AS order_count,
          (${LAST_PURCHASE}) AS last_purchase_at FROM clients WHERE id = ?`).get(req.params.id);
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM clients WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Client not found' });
  db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Activity log
router.get('/:id/messages', (req, res) => {
  const rows = db.prepare('SELECT * FROM messages WHERE client_id = ? ORDER BY date ASC').all(req.params.id);
  res.json({ data: rows });
});

router.post('/:id/messages', (req, res) => {
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const { type, content, date } = req.body;
  if (!type) return res.status(400).json({ error: 'type required' });

  const id = randomUUID();
  db.prepare('INSERT INTO messages (id, client_id, type, content, date) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.params.id, type, content || '', date || new Date().toISOString());

  res.status(201).json(db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
});

router.delete('/:clientId/messages/:msgId', (req, res) => {
  db.prepare('DELETE FROM messages WHERE id = ? AND client_id = ?').run(req.params.msgId, req.params.clientId);
  res.json({ ok: true });
});

export default router;
