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

  const revenue   = db.prepare('SELECT COALESCE(SUM(ca_lifetime),0) AS n FROM clients WHERE won = 1').get().n;
  const panierMoy = wonCount > 0
    ? db.prepare('SELECT COALESCE(AVG(ca_lifetime),0) AS n FROM clients WHERE won = 1 AND ca_lifetime > 0').get().n
    : 0;
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

export default router;
