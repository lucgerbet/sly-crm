import db from '../db.js';
import { getSettings } from '../routes/settings.js';
import { sendEmail, isEmailConfigured } from './email.js';
import { buildBalanceEmail } from './balanceEmails.js';
import { logMessage } from './orderHelpers.js';

// Chases the balance after the recap email has gone out. Runs daily (see the
// cron entry in index.js); the delays are measured from recap_email_sent_at,
// so the schedule is derived fresh on every run rather than stored — a missed
// day catches up on the next tick instead of skipping a client silently.
//
// Both windows are counted from the recap, not from each other: "five working
// days" is the total the client has had, which is what the wording promises.
const REMINDER_1_CALENDAR_DAYS = 2;
const REMINDER_2_WORKING_DAYS = 5;

// Weekends only. French public holidays are deliberately out of scope — they
// would need a maintained calendar, and being a day early on the chase for the
// handful that fall mid-week is not worth that dependency.
export function addWorkingDays(from, days) {
  const d = new Date(from);
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) added += 1;
  }
  return d;
}

export function isDue({ recapSentAt, now, stage }) {
  if (!recapSentAt) return false;
  const sent = new Date(recapSentAt.replace(' ', 'T') + (recapSentAt.includes('Z') ? '' : 'Z'));
  if (Number.isNaN(sent.getTime())) return false;
  const threshold = stage === 'reminder1'
    ? new Date(sent.getTime() + REMINDER_1_CALENDAR_DAYS * 86400000)
    : addWorkingDays(sent, REMINDER_2_WORKING_DAYS);
  return now >= threshold;
}

// Only orders that were actually sent a recap, still owe a balance, and have a
// live payment link. `balance_status = 'link_created'` is the precise state:
// 'paid' means done, and anything earlier means no link exists to chase with.
const CANDIDATES_SQL = `
  SELECT * FROM orders
  WHERE recap_email_sent_at IS NOT NULL
    AND balance_status = 'link_created'
    AND stripe_payment_link_url IS NOT NULL
    AND (balance_reminder_1_sent_at IS NULL OR balance_reminder_2_sent_at IS NULL)
`;

export async function runBalanceReminderJob({ dryRun = false, now = new Date() } = {}) {
  if (!isEmailConfigured()) {
    return { skipped: true, reason: 'RESEND_API_KEY not configured', reminders: [] };
  }

  const settings = getSettings();
  const candidates = db.prepare(CANDIDATES_SQL).all();
  const reminders = [];

  for (const order of candidates) {
    // Second chase takes precedence: once an order is that overdue, sending
    // the gentler first reminder late would be the wrong message.
    let stage = null;
    if (!order.balance_reminder_2_sent_at && isDue({ recapSentAt: order.recap_email_sent_at, now, stage: 'reminder2' })) {
      stage = 'reminder2';
    } else if (!order.balance_reminder_1_sent_at && isDue({ recapSentAt: order.recap_email_sent_at, now, stage: 'reminder1' })) {
      stage = 'reminder1';
    }
    if (!stage) continue;

    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(order.client_id);
    if (!client?.email) {
      reminders.push({ order: order.order_number || order.id, stage, sent: false, error: 'client has no email' });
      continue;
    }
    if (client.email_opt_out) {
      // Transactional rather than marketing, so this is arguable — but a
      // client who asked for no automated email gets chased by Luc directly.
      reminders.push({ order: order.order_number || order.id, stage, sent: false, error: 'client opted out' });
      continue;
    }

    const { subject, html, text } = buildBalanceEmail({ stage, order, client, settings });

    if (dryRun) {
      reminders.push({ order: order.order_number || order.id, stage, subject, sent: false, dryRun: true });
      continue;
    }

    const result = await sendEmail({ to: client.email, subject, text, html });
    if (result.ok) {
      const col = stage === 'reminder2' ? 'balance_reminder_2_sent_at' : 'balance_reminder_1_sent_at';
      // Reaching the second chase implies the first is moot — stamping it too
      // stops the job from later sending a softer reminder after a firmer one.
      const also = stage === 'reminder2' && !order.balance_reminder_1_sent_at
        ? ", balance_reminder_1_sent_at = COALESCE(balance_reminder_1_sent_at, datetime('now'))"
        : '';
      db.prepare(`UPDATE orders SET ${col} = datetime('now')${also} WHERE id = ?`).run(order.id);
      logMessage(client.id, 'note', `${subject}\n\n${text}`);
    }
    reminders.push({ order: order.order_number || order.id, stage, subject, sent: result.ok, error: result.error });
  }

  return { skipped: false, dryRun, reminders };
}
