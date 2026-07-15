import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import db from '../db.js';

const router = Router();

const CLIENT_FIELDS = [
  'first_name','last_name','phone','email','city','country','source','tags','notes',
  'birth_date','email_opt_out',
  'next_step','last_contacted_date','target_contact_date',
  'ca_lifetime','purchase_count','last_purchase_date','last_purchase_item',
  'assigned_to','potential',
  'contacted','answered','appointment','appointment_date','appointment_time','appointment_location','won',
  'lost','lost_reason',
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

// Sequential pipeline: each step requires the previous one to already be true.
const STAGE_FLAGS = ['contacted','answered','appointment','won'];
const STAGE_PREREQ = { answered: 'contacted', appointment: 'answered', won: 'appointment' };

// Lifetime-value tiers. Generic thresholds for a brand starting from zero —
// edit here (and in frontend/src/labels.js VALUE_TIERS) once real numbers are known.
const VALUE_TIER_SQL = {
  bronze:   'ca_lifetime < 500',
  silver:   'ca_lifetime >= 500 AND ca_lifetime < 2000',
  gold:     'ca_lifetime >= 2000 AND ca_lifetime < 5000',
  platinum: 'ca_lifetime >= 5000',
};

router.get('/', (req, res) => {
  const { q, timing, stage, valueTier, assignedTo } = req.query;
  let sql = `SELECT *, (${EFF_TIMING}) AS eff_timing FROM clients WHERE 1=1`;
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

router.get('/:id', (req, res) => {
  const row = db.prepare(`SELECT *, (${EFF_TIMING}) AS eff_timing FROM clients WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Client not found' });
  res.json(row);
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
  const created = db.prepare(`SELECT *, (${EFF_TIMING}) AS eff_timing FROM clients WHERE id = ?`).get(id);
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

  const updated = db.prepare(`SELECT *, (${EFF_TIMING}) AS eff_timing FROM clients WHERE id = ?`).get(req.params.id);
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
