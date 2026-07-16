import db from '../db.js';
import { getSettings } from '../routes/settings.js';
import { sendEmail, isEmailConfigured, renderTemplate } from './email.js';
import { productLabel, formatAppointmentDate, formatAppointmentTime, logMessage } from './orderHelpers.js';

// Runs every 15 minutes (see index.js cron schedule). The window is
// intentionally wider than the poll interval and asymmetric — this
// guarantees every appointment's "2 hours before" instant is visible across
// at least two consecutive polls, so a delayed tick (VPS load, container
// restart) can't silently skip a reminder. reminder_sent_at is the real
// dedup guard: safe for the same appointment to match this WHERE clause on
// more than one poll.
const WINDOW_SQL = `
  status = 'scheduled' AND reminder_sent_at IS NULL
  AND datetime(starts_at, '-2 hours') BETWEEN datetime('now', '-20 minutes') AND datetime('now', '+5 minutes')
`;

export async function runAppointmentReminderJob({ dryRun = false } = {}) {
  if (!isEmailConfigured()) {
    return { skipped: true, reason: 'RESEND_API_KEY not configured', reminders: [] };
  }

  const settings = getSettings();
  const due = db.prepare(`SELECT * FROM appointments WHERE ${WINDOW_SQL}`).all();

  const reminders = [];
  for (const appt of due) {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(appt.client_id);
    if (!client?.email) { reminders.push({ appointment: appt, sent: false, error: 'client has no email' }); continue; }

    const order = appt.order_id ? db.prepare('SELECT * FROM orders WHERE id = ?').get(appt.order_id) : null;
    const vars = {
      first_name: client.first_name || '',
      product_label: productLabel(order?.product_type),
      appointment_date: formatAppointmentDate(appt.starts_at),
      appointment_time: formatAppointmentTime(appt.starts_at),
      appointment_location: appt.location || '',
    };
    const subject = renderTemplate(settings.appointment_reminder_subject, vars);
    const text = renderTemplate(settings.appointment_reminder_body, vars);

    if (dryRun) { reminders.push({ appointment: appt, client, subject, sent: false }); continue; }

    const result = await sendEmail({ to: client.email, subject, text });
    if (result.ok) {
      db.prepare(`UPDATE appointments SET reminder_sent_at = datetime('now') WHERE id = ?`).run(appt.id);
      logMessage(client.id, 'appointment_reminder', `${subject}\n\n${text}`);
    }
    reminders.push({ appointment: appt, client, subject, sent: result.ok, error: result.error });
  }

  return { skipped: false, dryRun, reminders };
}
