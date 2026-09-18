// Meetings from the stylist tool — drafts and closed ones — mirrored here so
// they survive the browser that ran them and show up on every device.
//
// The CRM is a store, not an owner: the payload is the tool's Appointment
// object, opaque to this side. Conflict resolution is by the tool's own
// updatedAt — the newer write wins, whichever device it came from — which is
// enough for one stylist working from two devices, and honest about what it
// is not (a merge).
import { Router } from 'express';
import db from '../db.js';
import { requireIntakeSecret } from '../lib/orderHelpers.js';

const router = Router();
router.use(requireIntakeSecret);

const summary = (r) => ({
  id: r.id,
  status: r.status,
  clientName: r.client_name,
  orderNumber: r.order_number,
  crmOrderId: r.crm_order_id,
  stepIndex: r.step_index,
  device: r.device,
  updatedAt: r.updated_at,
  closedAt: r.closed_at,
});

// GET /api/meetings — every meeting, payload included: the tool merges the
// whole set into its local store at startup. Volume is one stylist's
// meetings, not a firehose.
router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM meetings ORDER BY updated_at DESC').all();
  res.json({
    data: rows.map((r) => ({ ...summary(r), payload: JSON.parse(r.payload_json) })),
  });
});

// PUT /api/meetings/:id — upsert. Refused (409, with the stored copy) when
// the server holds a strictly newer version: the caller then takes that
// one rather than overwriting work done on another device.
router.put('/:id', (req, res) => {
  const { payload, status, clientName, orderNumber, crmOrderId, stepIndex, device, updatedAt, closedAt, force } = req.body || {};
  if (!payload || typeof payload !== 'object') return res.status(400).json({ error: 'payload is required' });
  if (!updatedAt) return res.status(400).json({ error: 'updatedAt is required' });
  if (!['draft', 'closed'].includes(status)) return res.status(400).json({ error: 'status must be draft or closed' });

  const existing = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
  if (existing && !force && existing.updated_at > updatedAt) {
    return res.status(409).json({
      error: 'A newer version of this meeting exists',
      meeting: { ...summary(existing), payload: JSON.parse(existing.payload_json) },
    });
  }

  db.prepare(`
    INSERT INTO meetings (id, status, client_name, order_number, crm_order_id, step_index, payload_json, device, updated_at, closed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status, client_name = excluded.client_name, order_number = excluded.order_number,
      crm_order_id = excluded.crm_order_id, step_index = excluded.step_index, payload_json = excluded.payload_json,
      device = excluded.device, updated_at = excluded.updated_at, closed_at = excluded.closed_at,
      synced_at = datetime('now')
  `).run(
    req.params.id, status, clientName || null, orderNumber || null, crmOrderId || null,
    Number.isInteger(stepIndex) ? stepIndex : null, JSON.stringify(payload), device || null,
    updatedAt, closedAt || null,
  );
  res.json({ ok: true, meeting: summary(db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id)) });
});

// DELETE /api/meetings/:id — the stylist chose "delete for good".
router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM meetings WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
