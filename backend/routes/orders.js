import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import db from '../db.js';
import { sendEmail, renderTemplate, wrapHtml } from '../lib/email.js';
import { createBalancePaymentLink, isStripeConfigured } from '../lib/stripe.js';
import { getSettings } from './settings.js';
import {
  requireIntakeSecret, findOrCreateClient, formatMoney, summarizeConfig, nextOrderNumber, logMessage,
} from '../lib/orderHelpers.js';

const router = Router();

// POST /api/orders/intake — called by sly-shop right after it creates the
// deposit Stripe Checkout session, before redirecting the customer to pay.
// Stages a pending order so the CRM has the full config even though Stripe's
// own metadata can't hold it (500-char/50-key limits).
router.post('/intake', requireIntakeSecret, (req, res) => {
  const { stripeCheckoutSessionId, productType, depositAmountCents, customer, config } = req.body || {};
  if (!stripeCheckoutSessionId || !customer?.email) {
    return res.status(400).json({ error: 'stripeCheckoutSessionId and customer.email are required' });
  }

  const client = findOrCreateClient({ name: customer.name, email: customer.email, source: 'sly-shop' });

  const existing = db.prepare('SELECT id FROM orders WHERE stripe_checkout_session_id = ?').get(stripeCheckoutSessionId);
  let orderId;
  if (existing) {
    orderId = existing.id;
    db.prepare(`
      UPDATE orders SET client_id = ?, product_type = ?, deposit_amount_cents = ?, config_json = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(client.id, productType || null, depositAmountCents ?? null, JSON.stringify(config || {}), orderId);
  } else {
    orderId = randomUUID();
    db.prepare(`
      INSERT INTO orders (id, client_id, stripe_checkout_session_id, product_type, deposit_amount_cents, config_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(orderId, client.id, stripeCheckoutSessionId, productType || null, depositAmountCents ?? null, JSON.stringify(config || {}));
    logMessage(client.id, 'order_intake', `New order staged (${productType || 'unknown product'})`);
  }

  res.status(201).json({ orderId, clientId: client.id, status: 'deposit_pending' });
});

// POST /api/orders/finalize — will be called by the future order-taking tool
// once a stylist finishes an in-person meeting. Not called by anything yet,
// but built now so it's ready. Requires the deposit to already be paid.
router.post('/finalize', requireIntakeSecret, async (req, res) => {
  try {
    const { orderId, stripeCheckoutSessionId, finalConfig, finalProductType, totalAmountCents } = req.body || {};
    if ((!orderId && !stripeCheckoutSessionId) || !totalAmountCents) {
      return res.status(400).json({ error: 'orderId (or stripeCheckoutSessionId) and totalAmountCents are required' });
    }

    const order = orderId
      ? db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId)
      : db.prepare('SELECT * FROM orders WHERE stripe_checkout_session_id = ?').get(stripeCheckoutSessionId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.deposit_status !== 'paid') {
      return res.status(409).json({ error: 'Deposit not paid yet — cannot finalize' });
    }

    // Idempotent: a retried/double-tapped finalize call returns the existing link.
    if (order.balance_status !== 'not_created') {
      return res.json({
        orderId: order.id,
        balanceAmountCents: order.balance_amount_cents,
        paymentLinkUrl: order.stripe_payment_link_url,
        status: order.status,
      });
    }

    if (!isStripeConfigured()) return res.status(400).json({ error: 'STRIPE_SECRET_KEY not configured' });

    const settings = getSettings();
    const balanceAmountCents = totalAmountCents - (order.deposit_amount_cents || 0);
    const orderNumber = order.order_number || nextOrderNumber();
    const productLabel = finalProductType || order.product_type || 'your order';

    const link = await createBalancePaymentLink({
      orderId: order.id, amountCents: balanceAmountCents, label: productLabel,
    });

    db.prepare(`
      UPDATE orders SET
        config_json = ?, config_source = 'order_tool_final', product_type = ?,
        balance_amount_cents = ?, stripe_payment_link_id = ?, stripe_payment_link_url = ?,
        balance_status = 'link_created', status = 'finalized', order_number = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(JSON.stringify(finalConfig || {}), productLabel, balanceAmountCents, link.id, link.url, orderNumber, order.id);

    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(order.client_id);
    const vars = {
      first_name: client.first_name || '',
      product_label: productLabel,
      config_summary: summarizeConfig(finalConfig || order.config_json),
      deposit_amount: formatMoney(order.deposit_amount_cents, settings.currency),
      balance_amount: formatMoney(balanceAmountCents, settings.currency),
      total_amount: formatMoney(totalAmountCents, settings.currency),
      payment_link_url: link.url,
    };
    const subject = renderTemplate(settings.order_recap_subject, vars);
    const text = renderTemplate(settings.order_recap_body, vars);

    let sent = { ok: false };
    if (client.email) {
      sent = await sendEmail({
        to: client.email, subject, text,
        html: wrapHtml(text, { ctaUrl: link.url, ctaLabel: 'Complete my order' }),
      });
    }
    if (sent.ok) {
      db.prepare(`UPDATE orders SET status = 'balance_link_sent', recap_email_sent_at = datetime('now') WHERE id = ?`).run(order.id);
      logMessage(client.id, 'order_finalized', `${subject}\n\n${text}`);
    }

    res.json({ orderId: order.id, balanceAmountCents, paymentLinkUrl: link.url, status: sent.ok ? 'balance_link_sent' : 'finalized' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
