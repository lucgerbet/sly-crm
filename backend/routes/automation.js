import { Router } from 'express';
import db from '../db.js';
import { isEmailConfigured, sendEmail } from '../lib/email.js';
import { runBirthdayAutomation } from '../lib/birthdayJob.js';
import { getSettings } from './settings.js';

const router = Router();

function baseUrlFrom(req) {
  return process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

router.get('/status', (_req, res) => {
  const settings = getSettings();
  const recent = db.prepare(`
    SELECT m.id, m.type, m.date, c.id AS client_id, c.first_name, c.last_name
    FROM messages m JOIN clients c ON c.id = m.client_id
    WHERE m.type IN ('birthday_reminder','birthday_greeting')
    ORDER BY m.date DESC LIMIT 20
  `).all();
  res.json({
    emailConfigured: isEmailConfigured(),
    automationEnabled: settings.automation_enabled,
    reminderDaysBefore: settings.birthday_reminder_days_before,
    recent,
  });
});

router.post('/run', async (req, res) => {
  try {
    const dryRun = req.query.dryRun === '1' || req.body?.dryRun === true;
    const result = await runBirthdayAutomation({ baseUrl: baseUrlFrom(req), dryRun });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/test-email', async (req, res) => {
  const { to } = req.body || {};
  if (!to) return res.status(400).json({ error: 'to is required' });
  if (!isEmailConfigured()) return res.status(400).json({ error: 'RESEND_API_KEY not configured' });
  const result = await sendEmail({
    to,
    subject: 'SLY CRM — test email',
    text: 'This is a test email from SLY CRM. If you got this, Resend is wired up correctly.',
  });
  if (!result.ok) return res.status(502).json({ error: result.error });
  res.json({ ok: true });
});

export default router;
