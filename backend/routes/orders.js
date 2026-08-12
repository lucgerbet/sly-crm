import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import db from '../db.js';
import { sendEmail, renderTemplate, wrapHtml } from '../lib/email.js';
import { createBalancePaymentLink, isStripeConfigured } from '../lib/stripe.js';
import { buildProductionOrderPdf, buildInvoicePdf } from '../lib/pdf.js';
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
  const { stripeCheckoutSessionId, productType, depositAmountCents, customer, config, configSummary } = req.body || {};
  if (!stripeCheckoutSessionId || !customer?.email) {
    return res.status(400).json({ error: 'stripeCheckoutSessionId and customer.email are required' });
  }

  const client = findOrCreateClient({ name: customer.name, email: customer.email, source: 'sly-shop', referredBy: customer.referredBy });

  const existing = db.prepare('SELECT id FROM orders WHERE stripe_checkout_session_id = ?').get(stripeCheckoutSessionId);
  let orderId;
  if (existing) {
    orderId = existing.id;
    db.prepare(`
      UPDATE orders SET client_id = ?, product_type = ?, deposit_amount_cents = ?, config_json = ?, config_summary = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(client.id, productType || null, depositAmountCents ?? null, JSON.stringify(config || {}), JSON.stringify(configSummary || []), orderId);
  } else {
    orderId = randomUUID();
    const orderNumber = nextOrderNumber();
    db.prepare(`
      INSERT INTO orders (id, client_id, stripe_checkout_session_id, product_type, deposit_amount_cents, config_json, config_summary, order_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(orderId, client.id, stripeCheckoutSessionId, productType || null, depositAmountCents ?? null, JSON.stringify(config || {}), JSON.stringify(configSummary || []), orderNumber);
    logMessage(client.id, 'order_intake', `New order staged (${productType || 'unknown product'}) — ${orderNumber}`);
  }

  res.status(201).json({ orderId, clientId: client.id, status: 'deposit_pending' });
});

// GET /api/orders/search?q=... — used by the in-person order-taking tool to
// find a client's already-staged order by name, email, or order number, so
// the stylist can link the meeting to a real online-paid deposit instead of
// re-entering the client from scratch. `depositStatus` in the response is
// the server-truth signal the caller must trust over any local state.
router.get('/search', requireIntakeSecret, (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (q.length < 2) return res.json({ data: [] });
  const like = `%${q}%`;
  const rows = db.prepare(`
    SELECT o.id AS order_id, o.order_number, o.product_type, o.config_summary,
           o.deposit_status, o.balance_status, o.status, o.created_at,
           c.id AS client_id, c.first_name, c.last_name, c.email
    FROM orders o
    JOIN clients c ON c.id = o.client_id
    WHERE o.order_number LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ? OR c.email LIKE ?
    ORDER BY o.created_at DESC
    LIMIT 20
  `).all(like, like, like, like);

  const data = rows.map((r) => ({
    orderId: r.order_id,
    orderNumber: r.order_number,
    clientId: r.client_id,
    firstName: r.first_name,
    lastName: r.last_name,
    email: r.email,
    productType: r.product_type,
    configSummary: JSON.parse(r.config_summary || '[]'),
    depositStatus: r.deposit_status,
    balanceStatus: r.balance_status,
    status: r.status,
    createdAt: r.created_at,
  }));
  res.json({ data });
});

// POST /api/orders/finalize — will be called by the future order-taking tool
// once a stylist finishes an in-person meeting. Not called by anything yet,
// but built now so it's ready. Requires the deposit to already be paid.
router.post('/finalize', requireIntakeSecret, async (req, res) => {
  try {
    const { orderId, stripeCheckoutSessionId, finalConfig, finalConfigSummary, finalProductType, totalAmountCents } = req.body || {};
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

    // finalConfigSummary (French [label, value] rows, same shape as intake's
    // configSummary) is preferred when the caller supplies it — summarizeConfig()
    // assumes a flat object, but the order-taking tool's SuitConfiguration is
    // nested (jacket:{...}, trousers:{...}), which would otherwise render as
    // "Jacket: [object Object]" in the recap email. Once the meeting has
    // happened, the pre-meeting config_summary (e.g. tape-measure/shipping
    // note) is no longer relevant, so it's fully replaced rather than merged.
    const hasFinalSummary = Array.isArray(finalConfigSummary) && finalConfigSummary.length > 0;
    const configSummaryForEmail = hasFinalSummary
      ? finalConfigSummary.map(([label, value]) => `${label}: ${value}`).join('\n')
      : summarizeConfig(finalConfig || order.config_json);
    const configSummaryToStore = hasFinalSummary ? finalConfigSummary : JSON.parse(order.config_summary || '[]');

    db.prepare(`
      UPDATE orders SET
        config_json = ?, config_summary = ?, config_source = 'order_tool_final', product_type = ?,
        balance_amount_cents = ?, stripe_payment_link_id = ?, stripe_payment_link_url = ?,
        balance_status = 'link_created', status = 'finalized', order_number = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(JSON.stringify(finalConfig || {}), JSON.stringify(configSummaryToStore), productLabel, balanceAmountCents, link.id, link.url, orderNumber, order.id);

    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(order.client_id);
    const vars = {
      first_name: client.first_name || '',
      product_label: productLabel,
      config_summary: configSummaryForEmail,
      deposit_amount: formatMoney(order.deposit_amount_cents, settings.currency),
      balance_amount: formatMoney(balanceAmountCents, settings.currency),
      total_amount: formatMoney(totalAmountCents, settings.currency),
      payment_link_url: link.url,
      signature: settings.email_signature || '',
    };
    const subject = renderTemplate(settings.order_recap_subject, vars);
    const text = renderTemplate(settings.order_recap_body, vars);

    let sent = { ok: false };
    if (client.email) {
      sent = await sendEmail({
        to: client.email, subject, text,
        html: wrapHtml(text, { ctaUrl: link.url, ctaLabel: 'Compléter ma commande' }),
      });
    }
    if (sent.ok) {
      db.prepare(`UPDATE orders SET status = 'balance_link_sent', recap_email_sent_at = datetime('now') WHERE id = ?`).run(order.id);
      logMessage(client.id, 'order_finalized', `${subject}\n\n${text}`);
    }

    // Production order form for Luc to review — never sent to the workshop
    // directly, only to him, so he can check it before forwarding it himself.
    // Wrapped defensively: a PDF/email bug here must never fail the finalize
    // response the stylist is waiting on mid-meeting.
    try {
      if (settings.production_order_notify_email) {
        const pdfBuffer = await buildProductionOrderPdf({
          order: { ...order, balance_amount_cents: balanceAmountCents, order_number: orderNumber },
          client,
          config: finalConfig || {},
          currency: settings.currency,
        });
        const poVars = { first_name: client.first_name || '', last_name: client.last_name || '', product_label: productLabel, order_reference: orderNumber || order.id };
        await sendEmail({
          to: settings.production_order_notify_email,
          subject: renderTemplate(settings.production_order_subject, poVars),
          text: renderTemplate(settings.production_order_body, poVars),
          attachments: [{ filename: `bon-de-commande-${orderNumber || order.id}.pdf`, content: pdfBuffer }],
        });
      }
    } catch (e) {
      console.error('[orders/finalize] production order PDF/email failed (non-fatal):', e.message);
    }

    res.json({ orderId: order.id, balanceAmountCents, paymentLinkUrl: link.url, status: sent.ok ? 'balance_link_sent' : 'finalized' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/orders/:id/invoice.pdf — deliberately NOT behind requireIntakeSecret,
// unlike the rest of this router: it's meant to be opened directly in Luc's
// browser (protected by Traefik Basic Auth at the edge, same as the rest of
// the CRM), not called server-to-server. Invoice number = order_number (same
// sequence, Luc's choice — see nextOrderNumber()).
router.get('/:id/invoice.pdf', async (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(order.client_id);
    const settings = getSettings();
    const pdfBuffer = await buildInvoicePdf({ order, client, settings });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="facture-${order.order_number || order.id}.pdf"`);
    res.send(pdfBuffer);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
