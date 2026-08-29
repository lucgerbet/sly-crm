import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import db from '../db.js';
import { sendEmail, renderTemplate, wrapHtml } from '../lib/email.js';
import { runAppointmentReminderJob } from '../lib/appointmentReminderJob.js';
import { resolveScheduledEvent, isCalendlyConfigured } from '../lib/calendly.js';
import { buildOrderRecapPdf } from '../lib/pdf.js';
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
    const { stripeCheckoutSessionId, calendlyEventUri } = req.body || {};
    let { startTime, endTime, location } = req.body || {};
    if (!stripeCheckoutSessionId || (!startTime && !calendlyEventUri)) {
      return res.status(400).json({ error: 'stripeCheckoutSessionId and (startTime or calendlyEventUri) are required' });
    }

    // Calendly's `event_scheduled` postMessage never carries the actual
    // date/time — only the event URI. Resolve the real start/end time via
    // the Calendly API (works on the free plan; only webhooks are paid-only).
    if (!startTime && calendlyEventUri) {
      if (!isCalendlyConfigured()) {
        return res.status(500).json({ error: 'CALENDLY_API_TOKEN not configured' });
      }
      const resolved = await resolveScheduledEvent(calendlyEventUri);
      startTime = resolved.startTime;
      endTime = resolved.endTime;
      location = resolved.location;
    }

    const order = db.prepare('SELECT * FROM orders WHERE stripe_checkout_session_id = ?').get(stripeCheckoutSessionId);
    if (!order) return res.status(404).json({ error: 'No staged order for this checkout session' });

    let appointment = calendlyEventUri
      ? db.prepare('SELECT * FROM appointments WHERE calendly_event_uri = ?').get(calendlyEventUri)
      : null;

    if (appointment) {
      db.prepare(`UPDATE appointments SET starts_at = ?, ends_at = ?, location = ?, order_id = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(startTime, endTime || null, location || null, order.id, appointment.id);
    } else {
      const id = randomUUID();
      db.prepare(`
        INSERT INTO appointments (id, client_id, order_id, calendly_event_uri, source, starts_at, ends_at, location, status)
        VALUES (?, ?, ?, ?, 'postmessage_fallback', ?, ?, ?, 'scheduled')
      `).run(id, order.client_id, order.id, calendlyEventUri || null, startTime, endTime || null, location || null);
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
        signature: settings.email_signature || '',
      };
      const subject = renderTemplate(settings.appointment_confirmation_subject, vars);
      const text = renderTemplate(settings.appointment_confirmation_body, vars);

      let attachments;
      try {
        const rows = JSON.parse(order.config_summary || '[]');
        if (rows.length) {
          const pdf = await buildOrderRecapPdf({
            productLabel: productLabel(order.product_type),
            rows,
            appointmentDate: vars.appointment_date,
            appointmentTime: vars.appointment_time,
          });
          attachments = [{ filename: 'SLY-Atelier-recapitulatif.pdf', content: pdf }];
        }
      } catch (_) { /* no config_summary on this order — email still sends without it */ }

      // Luc wants his own copy of the recap PDF too, not just the client's —
      // CC'd rather than a second near-duplicate send.
      let sent = { ok: false };
      if (client?.email) {
        sent = await sendEmail({
          to: client.email, subject, text, html: wrapHtml(text), attachments,
          cc: settings.internal_notify_email || undefined,
        });
      }
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
