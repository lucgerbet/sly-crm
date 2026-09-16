// The atelier's own fabric library (2026-09-16) — see db.js's `fabrics`
// table comment. Two access surfaces on the same table: the plain CRUD
// routes below (Traefik Basic Auth at the edge, same as /api/sizes) for the
// CRM's own Fabrics tab, and a narrow secret-gated pair
// (/lookup, /register) for the stylist tool to search and add fabrics
// mid-meeting without exposing anything else here.
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import db from '../db.js';
import { requireIntakeSecret } from '../lib/orderHelpers.js';

const router = Router();

function toPublic(row) {
  return {
    id: row.id,
    name: row.name,
    reference: row.reference,
    color: row.color,
    composition: row.composition,
    priceCents: row.price_cents,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseFabricBody(body) {
  const name = (body?.name || '').toString().trim();
  const priceCents = body?.priceCents != null && body.priceCents !== ''
    ? Math.round(Number(body.priceCents))
    : null;
  return {
    name,
    reference: (body?.reference || '').toString().trim() || null,
    color: (body?.color || '').toString().trim() || null,
    composition: (body?.composition || '').toString().trim() || null,
    priceCents: Number.isFinite(priceCents) ? priceCents : null,
    notes: (body?.notes || '').toString().trim() || null,
  };
}

// GET /api/fabrics?q= — CRM's own list/search, for the Fabrics tab.
router.get('/', (req, res) => {
  const { q } = req.query;
  let sql = 'SELECT * FROM fabrics';
  const params = [];
  if (q) {
    sql += ' WHERE name LIKE ? OR reference LIKE ?';
    params.push(`%${q}%`, `%${q}%`);
  }
  sql += ' ORDER BY name COLLATE NOCASE ASC';
  const rows = db.prepare(sql).all(...params);
  res.json({ data: rows.map(toPublic) });
});

router.post('/', (req, res) => {
  const f = parseFabricBody(req.body);
  if (!f.name) return res.status(400).json({ error: 'name is required' });
  const id = randomUUID();
  db.prepare(
    'INSERT INTO fabrics (id, name, reference, color, composition, price_cents, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, f.name, f.reference, f.color, f.composition, f.priceCents, f.notes);
  res.status(201).json(toPublic(db.prepare('SELECT * FROM fabrics WHERE id = ?').get(id)));
});

router.patch('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM fabrics WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Fabric not found' });
  const f = parseFabricBody({ ...toPublic(existing), ...req.body });
  if (!f.name) return res.status(400).json({ error: 'name cannot be empty' });
  db.prepare(
    `UPDATE fabrics SET name = ?, reference = ?, color = ?, composition = ?, price_cents = ?, notes = ?,
     updated_at = datetime('now') WHERE id = ?`
  ).run(f.name, f.reference, f.color, f.composition, f.priceCents, f.notes, existing.id);
  res.json(toPublic(db.prepare('SELECT * FROM fabrics WHERE id = ?').get(existing.id)));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM fabrics WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// GET /api/fabrics/lookup?q= — narrow, secret-gated search for the stylist
// tool's "pick an existing fabric" list. Same fields as the CRM route
// above (nothing here is client data, so no narrower a shape is needed) —
// separated only so a public Traefik allowlist entry can target it
// specifically without opening the plain CRUD routes above.
router.get('/lookup', requireIntakeSecret, (req, res) => {
  const q = (req.query.q || '').toString().trim();
  let sql = 'SELECT * FROM fabrics';
  const params = [];
  if (q) {
    sql += ' WHERE name LIKE ? OR reference LIKE ?';
    params.push(`%${q}%`, `%${q}%`);
  }
  sql += ' ORDER BY name COLLATE NOCASE ASC LIMIT 30';
  const rows = db.prepare(sql).all(...params);
  res.json({ data: rows.map(toPublic) });
});

// POST /api/fabrics/register — same secret-gated pattern, for the stylist
// tool's "add a new fabric" form. The fabric it creates is immediately
// reusable by name/reference in every future meeting, which is the whole
// point of this table existing — a one-off entry typed into a meeting and
// never saved anywhere was the old customFabric behaviour this replaces.
router.post('/register', requireIntakeSecret, (req, res) => {
  const f = parseFabricBody(req.body);
  if (!f.name) return res.status(400).json({ error: 'name is required' });
  const id = randomUUID();
  db.prepare(
    'INSERT INTO fabrics (id, name, reference, color, composition, price_cents, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, f.name, f.reference, f.color, f.composition, f.priceCents, f.notes);
  res.status(201).json(toPublic(db.prepare('SELECT * FROM fabrics WHERE id = ?').get(id)));
});

export default router;
