import { Router } from 'express';
import db from '../db.js';

const router = Router();

const EFF_TIMING = `
  CASE
    WHEN target_contact_date IS NULL THEN NULL
    WHEN date(target_contact_date) <= date('now') THEN 'now'
    WHEN julianday(target_contact_date) <= julianday('now','+31 days') THEN '1month'
    WHEN julianday(target_contact_date) <= julianday('now','+92 days') THEN '3months'
    ELSE '6months'
  END`;

router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM clients').all();
  const total = rows.length;

  const funnel = [
    { key: 'new',         label: 'New leads',  n: total },
    { key: 'contacted',   label: 'Contacted',  n: rows.filter(r => r.contacted).length },
    { key: 'replied',     label: 'Replied',    n: rows.filter(r => r.answered).length },
    { key: 'appointment', label: 'Meeting',    n: rows.filter(r => r.appointment).length },
    { key: 'won',         label: 'Client',     n: rows.filter(r => r.won).length },
  ];

  const stageSplit = { new: 0, contacted: 0, replied: 0, appointment: 0, won: 0, lost: 0 };
  for (const r of rows) {
    if (r.lost) stageSplit.lost++;
    else if (r.won) stageSplit.won++;
    else if (r.appointment) stageSplit.appointment++;
    else if (r.answered) stageSplit.replied++;
    else if (r.contacted) stageSplit.contacted++;
    else stageSplit.new++;
  }

  const byTiming = db.prepare(`
    SELECT eff AS k, COUNT(*) AS n FROM (
      SELECT (${EFF_TIMING}) AS eff FROM clients WHERE target_contact_date IS NOT NULL AND lost = 0
    ) GROUP BY eff
  `).all();

  const byPotential = db.prepare(`
    SELECT potential AS k, COUNT(*) AS n FROM clients
    WHERE potential IS NOT NULL AND potential != '' GROUP BY k
  `).all();

  const contactsByWeek = db.prepare(`
    SELECT strftime('%Y-%W', contacted_at) AS wk, COUNT(*) AS n
    FROM clients
    WHERE contacted = 1 AND contacted_at IS NOT NULL
      AND julianday(contacted_at) >= julianday('now','-56 days')
    GROUP BY wk ORDER BY wk ASC
  `).all();

  res.json({ total, funnel, stageSplit, byTiming, byPotential, contactsByWeek });
});

export default router;
