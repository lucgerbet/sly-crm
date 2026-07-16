import { Router } from 'express';
import db from '../db.js';
import { verifyWebhookSignature } from '../lib/stripe.js';
import { sendEmail, renderTemplate } from '../lib/email.js';
import { getSettings } from './settings.js';
import { formatMoney, logMessage } from '../lib/orderHelpers.js';

const router = Router();

// Mounted with express.raw() in index.js — req.body here is the raw Buffer
// Stripe's signature check requires, NOT JSON-parsed. See the raw-body
// carve-out comment in index.js; this route silently breaks without it.
router.post('/stripe', async (req, res) => {
  let event;
  try {
    event = verifyWebhookSignature(req.body, req.headers['stripe-signature']);
  } catch (e) {
    return res.status(400).send(`Webhook signature verification failed: ${e.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const kind = session.metadata?.kind;

    if (kind === 'deposit') {
      const order = db.prepare('SELECT * FROM orders WHERE stripe_checkout_session_id = ?').get(session.id);
      if (!order) {
        console.error(`[stripe-webhook] deposit checkout.session.completed for unknown session ${session.id} — no order was staged via /api/orders/intake`);
      } else if (order.deposit_status !== 'paid') {
        db.prepare(`
          UPDATE orders SET deposit_status = 'paid', status = 'deposit_paid',
            stripe_deposit_payment_intent_id = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(session.payment_intent || null, order.id);
        logMessage(order.client_id, 'deposit_paid', `Deposit paid (${session.amount_total ? (session.amount_total / 100) : '?'} ${session.currency || ''})`);
      }
    }

    if (kind === 'balance') {
      const orderId = session.metadata?.orderId;
      const order = orderId ? db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) : null;
      if (!order) {
        console.error(`[stripe-webhook] balance checkout.session.completed with unknown orderId ${orderId}`);
      } else if (order.balance_status !== 'paid') {
        db.prepare(`
          UPDATE orders SET balance_status = 'paid', status = 'balance_paid',
            balance_stripe_session_id = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(session.id, order.id);

        const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(order.client_id);
        const settings = getSettings();
        const vars = {
          first_name: client?.first_name || '',
          product_label: order.product_type || 'your order',
          total_amount: formatMoney((order.deposit_amount_cents || 0) + (order.balance_amount_cents || 0), settings.currency),
          order_reference: order.order_number || order.id,
        };
        const subject = renderTemplate(settings.balance_payment_confirmation_subject, vars);
        const text = renderTemplate(settings.balance_payment_confirmation_body, vars);

        let sent = { ok: false };
        if (client?.email) sent = await sendEmail({ to: client.email, subject, text });
        if (sent.ok) {
          db.prepare(`UPDATE orders SET balance_confirmation_email_sent_at = datetime('now') WHERE id = ?`).run(order.id);
        }
        logMessage(order.client_id, 'balance_paid', `${subject}\n\n${text}`);
      }
    }
  }

  // Always 200 for anything we've already handled or don't care about —
  // Stripe retries indefinitely on non-2xx, and "order not found" is a
  // manual-follow-up case, not something retrying will ever fix.
  res.json({ received: true });
});

export default router;
