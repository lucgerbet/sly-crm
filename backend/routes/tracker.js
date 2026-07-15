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

const SELECT = `SELECT *, (${EFF_TIMING}) AS eff_timing FROM clients`;

router.get('/', (_req, res) => {
  const settings = getSettings();
  const dailyTarget = settings.daily_target || 3;
  const weeklyTarget = settings.weekly_target || 15;

  // Today's picks: not yet contacted, not lost, ordered timing -> potential -> created
  const picks = db.prepare(`
    ${SELECT}
    WHERE contacted = 0 AND lost = 0
    ORDER BY
      CASE (${EFF_TIMING})
        WHEN 'now' THEN 0 WHEN '1month' THEN 1 WHEN '3months' THEN 2 WHEN '6months' THEN 3 ELSE 4 END,
      CASE potential WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
      created_at ASC
    LIMIT ?
  `).all(dailyTarget);

  const overdue = db.prepare(`
    ${SELECT}
    WHERE contacted = 0 AND lost = 0
      AND target_contact_date IS NOT NULL
      AND date(target_contact_date) < date('now')
    ORDER BY target_contact_date ASC
  `).all();

  const upcoming = db.prepare(`
    ${SELECT}
    WHERE contacted = 0 AND lost = 0
      AND target_contact_date IS NOT NULL
      AND date(target_contact_date) >= date('now')
      AND date(target_contact_date) <= date('now','+7 days')
    ORDER BY target_contact_date ASC
  `).all();

  const contactedWeek = db.prepare(`
    ${SELECT}
    WHERE contacted = 1 AND contacted_at IS NOT NULL
      AND julianday(contacted_at) >= julianday('now','-7 days')
    ORDER BY contacted_at DESC
  `).all();

  const todayCount = db.prepare(`
    SELECT COUNT(*) AS n FROM clients
    WHERE contacted = 1 AND contacted_at IS NOT NULL
      AND date(contacted_at) = date('now')
  `).get().n;

  const weekCount = db.prepare(`
    SELECT COUNT(*) AS n FROM clients
    WHERE contacted = 1 AND contacted_at IS NOT NULL
      AND julianday(contacted_at) >= julianday('now','-7 days')
  `).get().n;

  res.json({
    picks,
    overdue,
    upcoming,
    contactedWeek,
    progress: { today: todayCount, dailyTarget, week: weekCount, weeklyTarget },
  });
});

export default router;
