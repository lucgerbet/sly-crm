import { randomUUID } from 'node:crypto';
import db from '../db.js';
import { getSettings } from '../routes/settings.js';
import { sendEmail, isEmailConfigured, renderTemplate } from './email.js';

// mm-dd for a given Date, in UTC (birth dates are stored as plain YYYY-MM-DD with no time zone)
function mmdd(date) {
  return `${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function alreadySent(clientId, type) {
  return !!db.prepare(`
    SELECT 1 FROM messages
    WHERE client_id = ? AND type = ? AND strftime('%Y', date) = strftime('%Y', 'now')
    LIMIT 1
  `).get(clientId, type);
}

function logMessage(clientId, type, content) {
  db.prepare('INSERT INTO messages (id, client_id, type, content, date) VALUES (?, ?, ?, ?, ?)')
    .run(randomUUID(), clientId, type, content, new Date().toISOString());
}

function unsubscribeFooter(clientId, baseUrl) {
  return `\n\n—\nDon't want these emails? Unsubscribe: ${baseUrl}/api/unsubscribe/${clientId}`;
}

// candidates: clients with a birth_date matching `targetMmDd`, an email, not opted out,
// not already sent this type this calendar year.
function findCandidates(targetMmDd, type) {
  const rows = db.prepare(`
    SELECT * FROM clients
    WHERE birth_date IS NOT NULL AND birth_date != ''
      AND email IS NOT NULL AND email != ''
      AND email_opt_out = 0
      AND lost = 0
      AND strftime('%m-%d', birth_date) = ?
  `).all(targetMmDd);
  return rows.filter(c => !alreadySent(c.id, type));
}

// baseUrl is needed to build the unsubscribe link (e.g. https://sly-crm.srv1758374.hstgr.cloud).
// dryRun previews who would be emailed without actually sending or logging anything.
export async function runBirthdayAutomation({ baseUrl, dryRun = false } = {}) {
  const settings = getSettings();
  const configured = isEmailConfigured();

  if (!configured) {
    return { skipped: true, reason: 'RESEND_API_KEY not configured', reminders: [], greetings: [] };
  }
  if (!settings.automation_enabled && !dryRun) {
    return { skipped: true, reason: 'automation disabled in settings', reminders: [], greetings: [] };
  }

  const today = new Date();
  const reminderDate = new Date(today);
  reminderDate.setUTCDate(reminderDate.getUTCDate() + (settings.birthday_reminder_days_before || 30));

  const reminderCandidates = findCandidates(mmdd(reminderDate), 'birthday_reminder');
  const greetingCandidates = findCandidates(mmdd(today), 'birthday_greeting');

  const reminders = [];
  const greetings = [];

  for (const c of reminderCandidates) {
    const vars = { first_name: c.first_name || '', last_name: c.last_name || '', shop_url: settings.shop_url || '' };
    const subject = renderTemplate(settings.birthday_reminder_subject, vars);
    let body = renderTemplate(settings.birthday_reminder_body, vars);
    if (baseUrl) body += unsubscribeFooter(c.id, baseUrl);

    if (dryRun) { reminders.push({ client: c, subject, body, sent: false }); continue; }

    const result = await sendEmail({ to: c.email, subject, text: body });
    if (result.ok) logMessage(c.id, 'birthday_reminder', `${subject}\n\n${body}`);
    reminders.push({ client: c, subject, sent: result.ok, error: result.error });
  }

  for (const c of greetingCandidates) {
    const vars = { first_name: c.first_name || '', last_name: c.last_name || '', shop_url: settings.shop_url || '' };
    const subject = renderTemplate(settings.birthday_greeting_subject, vars);
    let body = renderTemplate(settings.birthday_greeting_body, vars);
    if (baseUrl) body += unsubscribeFooter(c.id, baseUrl);

    if (dryRun) { greetings.push({ client: c, subject, body, sent: false }); continue; }

    const result = await sendEmail({ to: c.email, subject, text: body });
    if (result.ok) logMessage(c.id, 'birthday_greeting', `${subject}\n\n${body}`);
    greetings.push({ client: c, subject, sent: result.ok, error: result.error });
  }

  return { skipped: false, dryRun, reminders, greetings };
}
