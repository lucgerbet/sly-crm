import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import db from '../db.js';
import { sendEmail, renderTemplate } from '../lib/email.js';
import { runAppointmentReminderJob } from '../lib/appointmentReminderJob.js';
import { getSettings } from './settings.js';
import {
  requireIntakeSecret, productLabel, formatAppointmentDate, formatAppointmentTime, logMessage,
} from '../lib/orderHelpers.js';

const router = Router();

// POST /api/appointments/from-widget — public (bearer-gated), called by
// sly-shop's success page after Calendly's client-side `calendly.event_scheduled`
// postMessage fires. This is the Calendly integration path while on Calendly's
// free plan (no server-to-server webhooks available) — see the plan doc for
// the zero-schema-change upgrade path to a real Calendly webhook later.
router.post('/from-widget', requireIntakeSecret, async (req, res) => {
  try {
    const { stripeCheckoutSessionId, startTime, calendlyEventUri } = req.body || {};
    if (!stripeCheckoutSessionId || !startTime) {
      return res.status(400).json({ error: 'stripeCheckoutSessionId and startTime are required' });
    }

    const order = db.prepare('SELECT * FROM orders WHERE stripe_checkout_session_id = ?').get(stripeCheckoutSessionId);
    if (!order) return res.status(404).json({ error: 'No staged order for this checkout session' });

    let appointment = calendlyEventUri
      ? db.prepare('SELECT * FROM appointments WHERE calendly_event_uri = ?').get(calendlyEventUri)
      : null;

    if (appointment) {
      db.prepare(`UPDATE appointments SET starts_at = ?, order_id = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(startTime, order.id, appointment.id);
    } else {
      const id = randomUUID();
      db.prepare(`
        INSERT INTO appointments (id, client_id, order_id, calendly_event_uri, source, starts_at, status)
        VALUES (?, ?, ?, ?, 'postmessage_fallback', ?, 'scheduled')
      `).run(id, order.client_id, order.id, calendlyEventUri || null, startTime);
      appointment = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
    }

    db.prepare(`UPDATE orders SET appointment_id = ?, status = 'appointment_booked', updated_at = datetime('now') WHERE id = ?`)
      .run(appointment.id, order.id);

    if (!appointment.confirmation_email_sent_at) {
      const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(order.client_id);
      const settings = getSettings();
      const vars = {
        first_name: client?.first_name || '',
        product_label: productLabel(order.product_type),
        appointment_date: formatAppointmentDate(appointment.starts_at),
        appointment_time: formatAppointmentTime(appointment.starts_at),
        appointment_location: appointment.location || '',
      };
      const subject = renderTemplate(settings.appointment_confirmation_subject, vars);
      const text = renderTemplate(settings.appointment_confirmation_body, vars);

      let sent = { ok: false };
      if (client?.email) sent = await sendEmail({ to: client.email, subject, text });
      if (sent.ok) {
        db.prepare(`UPDATE appointments SET confirmation_email_sent_at = datetime('now') WHERE id = ?`).run(appointment.id);
        logMessage(client.id, 'appointment', `${subject}\n\n${text}`);
      }
    }

    res.status(201).json({ appointmentId: appointment.id, orderId: order.id, status: 'appointment_booked' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Human-authenticated (behind the normal Traefik Basic Auth — not added to
// the public router path list).
router.get('/reminder-status', (_req, res) => {
  const upcoming = db.prepare(`
    SELECT COUNT(*) AS n FROM appointments
    WHERE status = 'scheduled' AND datetime(starts_at) BETWEEN datetime('now') AND datetime('now', '+2 hours')
  `).get().n;
  const recent = db.prepare(`
    SELECT a.id, a.starts_at, a.reminder_sent_at, c.first_name, c.last_name
    FROM appointments a JOIN clients c ON c.id = a.client_id
    WHERE a.reminder_sent_at IS NOT NULL
    ORDER BY a.reminder_sent_at DESC LIMIT 20
  `).all();
  res.json({ upcomingIn2h: upcoming, recent });
});

router.post('/reminder-run', async (req, res) => {
  try {
    const dryRun = req.query.dryRun === '1' || req.body?.dryRun === true;
    const result = await runAppointmentReminderJob({ dryRun });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
