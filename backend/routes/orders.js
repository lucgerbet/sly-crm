import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import db from '../db.js';
import { sendEmail, renderTemplate, wrapHtml } from '../lib/email.js';
import { createBalancePaymentLink, deactivatePaymentLink, isStripeConfigured } from '../lib/stripe.js';
import { buildProductionOrderPdf, buildInvoicePdf } from '../lib/pdf.js';
import { buildTailoringOrderXlsx } from '../lib/xlsx.js';
import { buildBalanceEmail, BALANCE_EMAIL_STAGES } from '../lib/balanceEmails.js';
import { getSettings } from './settings.js';
import {
  requireIntakeSecret, findOrCreateClient, formatMoney, summarizeConfig, nextOrderNumber, logMessage,
  snapshotClientMeasurements, productLabel,
} from '../lib/orderHelpers.js';
import { matchSize, measurementsForOrder, parseRanges } from '../lib/sizeMatch.js';
import { catalogue, productCostCents } from './products.js';
import {
  PRODUCTION_STAGES, PRODUCTION_LABELS, STAGE_TIMESTAMP_COLUMN, CLIENT_EMAIL_STAGES,
  ALTERATION_STATUSES, ALTERATION_LABELS, ALTERATION_TIMESTAMP_COLUMN,
  ROUND_RESET_COLUMNS, isValidStage, isValidAlterationStatus, isLate,
} from '../lib/production.js';

const router = Router();

// POST /api/orders/intake — called by sly-shop right after it creates the
// deposit Stripe Checkout session, before redirecting the customer to pay.
// Stages a pending order so the CRM has the full config even though Stripe's
// own metadata can't hold it (500-char/50-key limits).
router.post('/intake', requireIntakeSecret, (req, res) => {
  const { stripeCheckoutSessionId, productType, depositAmountCents, quotedTotalCents, customer, config, configSummary } = req.body || {};
  // Older sly-shop deploys don't send it — stays NULL rather than 0, so an
  // unknown quote never renders as a 0 € order.
  const quoted = Number.isInteger(quotedTotalCents) && quotedTotalCents > 0 ? quotedTotalCents : null;
  if (!stripeCheckoutSessionId || !customer?.email) {
    return res.status(400).json({ error: 'stripeCheckoutSessionId and customer.email are required' });
  }

  const client = findOrCreateClient({
    firstName: customer.firstName, lastName: customer.lastName, name: customer.name,
    email: customer.email, source: 'sly-shop', referredBy: customer.referredBy,
  });

  const existing = db.prepare('SELECT id FROM orders WHERE stripe_checkout_session_id = ?').get(stripeCheckoutSessionId);
  let orderId;
  if (existing) {
    orderId = existing.id;
    db.prepare(`
      UPDATE orders SET client_id = ?, product_type = ?, deposit_amount_cents = ?, quoted_total_cents = COALESCE(?, quoted_total_cents),
        config_json = ?, config_summary = ?,
        shop_config_summary = ?, shop_config_json = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(client.id, productType || null, depositAmountCents ?? null, quoted, JSON.stringify(config || {}), JSON.stringify(configSummary || []), JSON.stringify(configSummary || []), JSON.stringify(config || {}), orderId);
  } else {
    orderId = randomUUID();
    const orderNumber = nextOrderNumber();
    db.prepare(`
      INSERT INTO orders (id, client_id, stripe_checkout_session_id, product_type, deposit_amount_cents, quoted_total_cents, config_json, config_summary, shop_config_summary, shop_config_json, order_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(orderId, client.id, stripeCheckoutSessionId, productType || null, depositAmountCents ?? null, quoted, JSON.stringify(config || {}), JSON.stringify(configSummary || []), JSON.stringify(configSummary || []), JSON.stringify(config || {}), orderNumber);
    logMessage(client.id, 'order_intake', `New order staged (${productType || 'unknown product'}) — ${orderNumber}`);
  }

  // Lift the tape-measure answer out of the config blob into real columns.
  // sly-shop makes the shipping address mandatory whenever the client answers
  // "no" (see its validation.ts), so needing a tape and having somewhere to
  // send it always arrive together — which is what makes the alert reliable.
  if (config && typeof config === 'object') {
    const needsTape = config.hasTapeMeasure === 'no' ? 1 : 0;
    const shipping = [config.shippingAddress, config.shippingZip, config.shippingCity]
      .filter(Boolean).join(', ');
    const sets = ['needs_tape_measure = ?'];
    const vals = [needsTape];
    // Never clobber an address already captured at Stripe checkout — only
    // fill the gap when the CRM has nothing.
    if (needsTape && shipping && !client.address) {
      sets.push('address = ?');
      vals.push(shipping);
    }
    db.prepare(`UPDATE clients SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .run(...vals, client.id);
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
    SELECT o.id AS order_id, o.order_number, o.product_type, o.config_summary, o.shop_config_json,
           o.config_json, o.config_source,
           o.deposit_status, o.balance_status, o.status, o.created_at,
           c.id AS client_id, c.first_name, c.last_name, c.email, c.phone, c.address
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
    phone: r.phone,
    address: r.address,
    productType: r.product_type,
    configSummary: JSON.parse(r.config_summary || '[]'),
    // Present for orders taken in via /intake after shop_config_json was
    // added (2026-08-13) — null for older orders, nothing to pre-fill from.
    shopConfig: JSON.parse(r.shop_config_json || '{}'),
    // Only meaningful when config_source is 'order_tool_final' — the order
    // was already walked through once and finalized, so config_json is
    // already in this app's own native shape (no translation needed, unlike
    // shopConfig) — lets re-linking to revisit/adjust a finalized order
    // restore exactly what was last configured instead of starting blank.
    finalConfig: r.config_source === 'order_tool_final' ? JSON.parse(r.config_json || '{}') : null,
    depositStatus: r.deposit_status,
    balanceStatus: r.balance_status,
    status: r.status,
    createdAt: r.created_at,
  }));
  res.json({ data });
});

// GET /api/orders/upcoming-meetings — used by the order-taking tool to list
// orders that are ready for their in-person/video meeting (deposit paid AND
// appointment booked, not yet walked through with a stylist) so it can
// pre-fill a new meeting draft from the client's website selections instead
// of starting blank. Only 'appointment_booked' orders qualify — once
// finalize() runs the status moves on and shop_config_json is no longer the
// current state to prefill from.
router.get('/upcoming-meetings', requireIntakeSecret, (req, res) => {
  const rows = db.prepare(`
    SELECT o.id AS order_id, o.order_number, o.product_type, o.shop_config_json, o.shop_config_summary,
           c.id AS client_id, c.first_name, c.last_name, c.email, c.phone, c.address,
           a.starts_at, a.location
    FROM orders o
    JOIN clients c ON c.id = o.client_id
    LEFT JOIN appointments a ON a.id = o.appointment_id
    WHERE o.status = 'appointment_booked'
    ORDER BY a.starts_at ASC
    LIMIT 50
  `).all();

  const data = rows.map((r) => ({
    orderId: r.order_id,
    orderNumber: r.order_number,
    clientId: r.client_id,
    firstName: r.first_name,
    lastName: r.last_name,
    email: r.email,
    phone: r.phone,
    address: r.address,
    productType: r.product_type,
    shopConfig: JSON.parse(r.shop_config_json || '{}'),
    shopConfigSummary: JSON.parse(r.shop_config_summary || '[]'),
    appointmentStartsAt: r.starts_at,
    appointmentLocation: r.location,
  }));
  res.json({ data });
});

// POST /api/orders/finalize — will be called by the future order-taking tool
// once a stylist finishes an in-person meeting. Not called by anything yet,
// but built now so it's ready. Requires the deposit to already be paid.
router.post('/finalize', requireIntakeSecret, async (req, res) => {
  try {
    const {
      orderId, stripeCheckoutSessionId, finalConfig, finalConfigSummary, finalProductType, totalAmountCents,
      // Production planning agreed during the meeting — previously filled in
      // by the stylist and then dropped on the floor here, which is why the
      // CRM had no idea when any piece was due back.
      workshopDeadline, productionNotes,
    } = req.body || {};
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

    // Idempotent only for an exact repeat (an accidental double-tap of
    // "send balance link" mid-meeting) — a genuinely different
    // totalAmountCents means the stylist deliberately corrected the price
    // and wants a fresh link and a resent email. This used to always return
    // the stale cached link and never send anything once a link already
    // existed, which is why "changer le prix et renvoyer le mail" silently
    // did nothing (2026-08-22 bug report) — the price change was accepted
    // by the stylist tool but had nowhere to go once it reached here.
    if (order.balance_status !== 'not_created') {
      const previousTotalCents = (order.deposit_amount_cents || 0) + (order.balance_amount_cents || 0);
      const priceUnchanged = totalAmountCents === previousTotalCents;
      if (order.balance_status === 'paid' || priceUnchanged) {
        return res.json({
          orderId: order.id,
          balanceAmountCents: order.balance_amount_cents,
          paymentLinkUrl: order.stripe_payment_link_url,
          status: order.status,
          ...(order.balance_status === 'paid' && !priceUnchanged
            ? { warning: 'Balance already paid — this price change was not applied. Adjust with the client directly.' }
            : {}),
        });
      }
      // Price actually changed and the balance isn't paid yet — deactivate
      // the old link so it can never be paid at the stale amount, then fall
      // through to create a new one and resend the recap email below.
      if (order.stripe_payment_link_id) {
        await deactivatePaymentLink(order.stripe_payment_link_id).catch((e) =>
          console.error('[orders/finalize] could not deactivate old payment link (non-fatal):', e.message));
      }
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
        finalized_at = COALESCE(finalized_at, datetime('now')),
        workshop_deadline = COALESCE(?, workshop_deadline),
        production_notes = COALESCE(?, production_notes),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      JSON.stringify(finalConfig || {}), JSON.stringify(configSummaryToStore), productLabel,
      balanceAmountCents, link.id, link.url, orderNumber,
      workshopDeadline || null, productionNotes || null,
      order.id,
    );

    // Best-effort second write, on top of the earlier one from
    // POST /api/clients/set-measurements (fires as soon as the Measurements
    // step is filled in, well before this finalize call — see that route's
    // comment). Catches the rare case where the config changed again between
    // then and finalize. No-ops if there's no actual measurement data.
    try {
      snapshotClientMeasurements(order.client_id, order.id, finalConfig || {});
    } catch (e) {
      console.error('[orders/finalize] measurements snapshot failed (non-fatal):', e.message);
    }

    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(order.client_id);

    // Rendered by the shared balance-email builder rather than inline, so the
    // recap and the two later chases stay identical in branding and — the
    // point of the exercise — all put the payment button above the detail
    // instead of after it. Reads the freshly-updated row so the amounts and
    // link it prints are the ones just committed.
    const freshOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    const { subject, html, text } = buildBalanceEmail({
      stage: 'recap',
      order: freshOrder,
      client,
      settings,
    });

    let sent = { ok: false };
    if (client.email) {
      sent = await sendEmail({
        to: client.email, subject, text, html,
        cc: settings.internal_notify_email || undefined,
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
        const finalOrder = { ...order, order_number: orderNumber };
        const finalConfigData = finalConfig || {};
        const shopConfigSummaryData = JSON.parse(order.shop_config_summary || '[]');
        const pdfBuffer = await buildProductionOrderPdf({
          order: finalOrder, client, config: finalConfigData, shopConfigSummary: shopConfigSummaryData,
        });
        // Luc's own standardized order form (2026-08-22) — same fields as the
        // PDF, auto-filled into his exact template instead of the CJK recap
        // layout, so he can hand it straight to the workshop without
        // re-typing anything. Attached alongside the PDF, not instead of it —
        // wrapped separately so a template bug never blocks the PDF/email the
        // stylist is waiting on.
        let xlsxBuffer = null;
        try {
          xlsxBuffer = await buildTailoringOrderXlsx({ order: finalOrder, client, config: finalConfigData });
        } catch (xe) {
          console.error('[orders/finalize] tailoring order xlsx failed (non-fatal):', xe.message);
        }
        const poVars = { first_name: client.first_name || '', last_name: client.last_name || '', product_label: productLabel, order_reference: orderNumber || order.id };
        await sendEmail({
          to: settings.production_order_notify_email,
          subject: renderTemplate(settings.production_order_subject, poVars),
          text: renderTemplate(settings.production_order_body, poVars),
          attachments: [
            { filename: `bon-de-commande-${orderNumber || order.id}.pdf`, content: pdfBuffer },
            ...(xlsxBuffer ? [{ filename: `bon-de-commande-${orderNumber || order.id}.xlsx`, content: xlsxBuffer }] : []),
          ],
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

// The docket email's HTML body. Tables and inline styles, like every other
// email here — and bilingual, because the two buttons are the whole point of
// the message: they are what turns "the workshop has it somewhere" into two
// real timestamps.
function workshopEmailHtml({ body, trackUrl, reference }) {
  // English and Chinese only — the workshop is in China and reads neither
  // French nor the CRM.
  const P = { offwhite: '#f8f4ef', ink: '#1a1410', cherry: '#5a1f24', border: '#e5ddd5', muted: '#6b5b4e' };
  const SANS = "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
  const paras = String(body || '').split(/\n{2,}/).map((t) => `
    <p style="margin:0 0 14px;font-family:${SANS};font-size:15px;line-height:1.6;color:${P.ink};">
      ${t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}
    </p>`).join('');

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:${P.offwhite};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${P.offwhite};">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid ${P.border};">
        <tr><td style="padding:30px 28px;">
          <div style="font-family:Georgia,serif;font-size:22px;letter-spacing:.28em;color:${P.ink};">SLY</div>
          <div style="font-family:${SANS};font-size:9px;letter-spacing:.32em;text-transform:uppercase;color:${P.muted};margin:4px 0 22px;">Atelier</div>
          ${paras}
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:8px;">
            <tr><td style="border-radius:2px;background:${P.cherry};">
              <a href="${trackUrl}" style="display:block;padding:16px 30px;font-family:${SANS};font-size:15px;color:#ffffff;text-decoration:none;">
                Open the production order (PDF)<br>点击打开生产订单（PDF）
              </a>
            </td></tr>
          </table>
          <p style="margin:18px 0 0;font-family:${SANS};font-size:12px;line-height:1.6;color:${P.muted};">
            If the button does not work, copy this address into your browser:<br>
            如果按钮无法打开，请将以下地址复制到浏览器：<br>
            <span style="word-break:break-all;">${trackUrl}</span>
          </p>
          <p style="margin:14px 0 0;font-family:${SANS};font-size:12px;color:${P.muted};">
            ${reference ? String(reference).replace(/</g, '&lt;') : ''}
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// Sends the docket to the workshop. Shared by the two callers below rather
// than duplicated: the stylist tool reaches it with the intake secret, the CRM
// with Luc's own Basic Auth session, and both must produce byte-for-byte the
// same email — a second copy of this logic would drift the day one is edited.
// Returns {status, body} for the caller to hand straight back.
async function sendDocketToWorkshop(orderId, mode = 'initial') {
  const isReminder = mode === 'reminder';
  if (!orderId) return { status: 400, body: { error: 'orderId is required' } };

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return { status: 404, body: { error: 'Order not found' } };
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(order.client_id);

  const settings = getSettings();
  if (!settings.workshop_notify_email) {
    return { status: 400, body: { error: 'workshop_notify_email is not configured yet' } };
  }

  const pdfBuffer = await buildProductionOrderPdf({
    order,
    client,
    config: JSON.parse(order.config_json || '{}'),
    shopConfigSummary: JSON.parse(order.shop_config_summary || '[]'),
  });
  const vars = {
    first_name: client.first_name || '',
    last_name: client.last_name || '',
    product_label: order.product_type || '',
    order_reference: order.order_number || order.id,
  };
  const subject = renderTemplate(
    isReminder ? settings.workshop_reminder_subject : settings.workshop_order_subject, vars);
  const body = renderTemplate(
    isReminder ? settings.workshop_reminder_body : settings.workshop_order_body, vars);

  // The turnaround link. Minted once per order and reused on every re-send,
  // so re-sending the docket never invalidates a link the workshop already
  // has open. Without PUBLIC_URL the email simply ships without the button
  // rather than with a link to nowhere.
  let workshopToken = order.workshop_token;
  if (!workshopToken) {
    workshopToken = randomUUID().replace(/-/g, '');
    db.prepare('UPDATE orders SET workshop_token = ? WHERE id = ?').run(workshopToken, order.id);
  }
  // Straight at the PDF, not at a landing page: one tap on a phone in China
  // is one tap too few to lose. The landing page still exists for anyone who
  // trims the URL.
  const trackUrl = process.env.PUBLIC_URL
    ? `${process.env.PUBLIC_URL.replace(/\/$/, '')}/workshop/${workshopToken}/bon-de-commande.pdf`
    : null;

  const sent = await sendEmail({
    to: settings.workshop_notify_email,
    subject,
    text: trackUrl ? `${body}\n\n---\nProduction order / 生产订单 (PDF):\n${trackUrl}` : body,
    html: trackUrl ? workshopEmailHtml({ body, trackUrl, reference: vars.order_reference }) : undefined,
    // A copy to Luc: this is the one email in the whole system that leaves
    // for a third party, and it should never go out with no trace anywhere he
    // can reach.
    cc: settings.internal_notify_email || undefined,
    // The docket is deliberately NOT attached when a tracking link exists:
    // an attachment gets opened without ever telling us, and the whole point
    // of the link is to measure how long the workshop takes to pick the order
    // up. Falls back to the attachment when PUBLIC_URL is unset, so a
    // misconfiguration can never leave the workshop with no docket at all.
    ...(trackUrl
      ? {}
      : { attachments: [{ filename: `bon-de-commande-${order.order_number || order.id}.pdf`, content: pdfBuffer }] }),
  });
  if (!sent.ok) return { status: 500, body: { error: 'Email send failed' } };

  logMessage(order.client_id, isReminder ? 'workshop_reminder' : 'workshop_order',
    `${isReminder ? 'Relance atelier' : 'Bon de commande envoyé à l\'atelier'}`
    + ` (${settings.workshop_notify_email})\n\n${subject}\n\n${body}`);

  if (isReminder) {
    db.prepare(`UPDATE orders SET workshop_reminder_sent_at = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(new Date().toISOString(), order.id);
  }

  // The send IS the stage change — advancing it here rather than relying on
  // Luc to also move it on the board keeps the two from drifting apart. Only
  // ever forward, so re-sending a docket for an order already in production
  // doesn't drag its status backwards.
  // A chase must never restart the clock it exists to measure, so only the
  // first send touches the stage and the sent-at stamp.
  if (!isReminder && order.production_status === 'not_started') {
    db.prepare(`
      UPDATE orders SET production_status = 'sent_to_workshop',
        sent_to_workshop_at = COALESCE(sent_to_workshop_at, ?), updated_at = datetime('now')
      WHERE id = ?
    `).run(new Date().toISOString(), order.id);
  }

  return { status: 200, body: { ok: true, sentTo: settings.workshop_notify_email } };
}

// POST /api/orders/send-to-workshop — called by the stylist tool once Luc has
// reviewed the production order PDF. Deliberately a separate, explicit action
// from /finalize (which only ever emails Luc himself, for review): sending to
// a third party happens only when he clicks the button, never automatically.
// orderId in the body, not the URL, so the Traefik public-router allowlist can
// match this exact static path (see docker-compose.yml).
router.post('/send-to-workshop', requireIntakeSecret, async (req, res) => {
  try {
    const { status, body } = await sendDocketToWorkshop(req.body?.orderId);
    res.status(status).json(body);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/orders/feedback — end-of-meeting client feedback, pushed by the
// stylist tool's Feedback step. Upserts on order_id so re-saving the step (or
// correcting an answer before the meeting ends) updates the same row instead
// of stacking duplicates. The recontact opt-ins that come with it are client-
// level, so they're written to `clients` via the same call — that's where a
// campaign query will look for them, not in a per-order feedback row.
router.post('/feedback', requireIntakeSecret, (req, res) => {
  const { orderId, feedback } = req.body || {};
  if (!orderId) return res.status(400).json({ error: 'orderId is required' });
  if (!feedback || typeof feedback !== 'object') {
    return res.status(400).json({ error: 'feedback is required' });
  }

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const row = {
    experience_note: feedback.experienceNote || null,
    time_saved: feedback.timeSaved || null,
    improvement_ideas: feedback.improvementIdeas || null,
    friction_points: feedback.frictionPoints || null,
  };
  const hasAnything = Object.values(row).some(Boolean);

  const existing = db.prepare('SELECT id FROM order_feedback WHERE order_id = ?').get(orderId);
  if (hasAnything) {
    if (existing) {
      db.prepare(`
        UPDATE order_feedback SET experience_note = ?, time_saved = ?, improvement_ideas = ?, friction_points = ?
        WHERE id = ?
      `).run(row.experience_note, row.time_saved, row.improvement_ideas, row.friction_points, existing.id);
    } else {
      db.prepare(`
        INSERT INTO order_feedback (id, order_id, client_id, experience_note, time_saved, improvement_ideas, friction_points)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), orderId, order.client_id, row.experience_note, row.time_saved, row.improvement_ideas, row.friction_points);
    }
    logMessage(order.client_id, 'note',
      `RETOUR D'EXPÉRIENCE (${order.order_number || orderId})\n\n`
      + [
        row.experience_note && `Ressenti : ${row.experience_note}`,
        row.time_saved && `Temps gagné : ${row.time_saved}`,
        row.improvement_ideas && `Idées d'amélioration : ${row.improvement_ideas}`,
        row.friction_points && `Points de friction : ${row.friction_points}`,
      ].filter(Boolean).join('\n'));
  }

  const consents = ['recontact_events', 'recontact_new_piece', 'recontact_seasonal']
    .filter((k) => feedback[k] !== undefined);
  if (consents.length) {
    db.prepare(
      `UPDATE clients SET ${consents.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`
    ).run(...consents.map((c) => (feedback[c] ? 1 : 0)), order.client_id);
  }

  res.json({ ok: true });
});

// GET /api/orders/revenue?period=month|year|all — the money, counted from the
// orders Stripe has actually confirmed.
//
// Deliberately NOT read from clients.ca_lifetime, which the dashboard used
// until now: that column is typed by hand and drifts from reality the moment
// anyone forgets to update it. Everything below is derived from
// deposit_status / balance_status, which only the Stripe webhook writes.
//
// Two amounts are kept strictly apart, because conflating them is how a
// business thinks it is richer than it is:
//   collected  — money that has cleared. Real.
//   outstanding — balances invoiced and still unpaid. Not yours yet.
// Orders whose deposit is paid but whose meeting hasn't happened have no
// agreed total at all, so they are counted but contribute nothing to either.
router.get('/revenue', (req, res) => {
  // Attribution is by payment date, not order date: a deposit taken in
  // January for an order created in December is January's money.
  const range = resolvePeriod(req.query);
  const period = range.label;
  const within = range.within;

  const one = (sql) => db.prepare(sql).get();

  const deposits = one(`
    SELECT COUNT(*) AS n, COALESCE(SUM(deposit_amount_cents),0) AS cents
    FROM orders WHERE deposit_status = 'paid' ${within('deposit_paid_at')}
  `);
  const balances = one(`
    SELECT COUNT(*) AS n, COALESCE(SUM(balance_amount_cents),0) AS cents
    FROM orders WHERE balance_status = 'paid' ${within('balance_paid_at')}
  `);
  // Outstanding ignores the period filter on purpose — money owed is owed
  // regardless of which month it was invoiced in.
  const outstanding = one(`
    SELECT COUNT(*) AS n, COALESCE(SUM(balance_amount_cents),0) AS cents
    FROM orders WHERE balance_status = 'link_created'
  `);
  const awaitingMeeting = one(`
    SELECT COUNT(*) AS n FROM orders
    WHERE deposit_status = 'paid' AND balance_status = 'not_created'
  `);
  const fullyPaid = one(`
    SELECT COUNT(*) AS n,
           COALESCE(SUM(deposit_amount_cents + balance_amount_cents),0) AS cents
    FROM orders
    WHERE deposit_status = 'paid' AND balance_status = 'paid' ${within('balance_paid_at')}
  `);

  // 12 months of cleared money, deposits and balances added on the month each
  // actually landed.
  const byMonth = db.prepare(`
    SELECT month, SUM(cents) AS cents FROM (
      SELECT strftime('%Y-%m', deposit_paid_at) AS month, deposit_amount_cents AS cents
        FROM orders WHERE deposit_status = 'paid' AND deposit_paid_at IS NOT NULL
      UNION ALL
      SELECT strftime('%Y-%m', balance_paid_at) AS month, balance_amount_cents AS cents
        FROM orders WHERE balance_status = 'paid' AND balance_paid_at IS NOT NULL
    )
    WHERE month IS NOT NULL
    GROUP BY month ORDER BY month DESC LIMIT 12
  `).all();

  // Projected: what the book is worth once every order already in flight is
  // settled. Two populations, kept separate so the figure stays honest:
  //  - agreed  — the total was fixed at the fitting call (deposit + balance);
  //  - quoted  — deposit paid, call not held yet, so the only total known is
  //              the price the site showed the client. Counted, because the
  //              order is genuinely in flight, but reported separately.
  // An order awaiting its call with no quote recorded (pre-2026-08-19 intake)
  // contributes nothing and is counted in `unknownCount` rather than assumed.
  const agreed = one(`
    SELECT COUNT(*) AS n,
           COALESCE(SUM(deposit_amount_cents + balance_amount_cents),0) AS cents
    FROM orders
    WHERE deposit_status = 'paid' AND balance_status IN ('link_created','paid')
  `);
  const quotedInFlight = one(`
    SELECT COUNT(*) AS n, COALESCE(SUM(quoted_total_cents),0) AS cents
    FROM orders
    WHERE deposit_status = 'paid' AND balance_status = 'not_created'
      AND quoted_total_cents IS NOT NULL
  `);
  const unknownInFlight = one(`
    SELECT COUNT(*) AS n FROM orders
    WHERE deposit_status = 'paid' AND balance_status = 'not_created'
      AND quoted_total_cents IS NULL
  `);
  const projected = {
    n: agreed.n + quotedInFlight.n,
    cents: agreed.cents + quotedInFlight.cents,
    quotedCount: quotedInFlight.n,
    unknownCount: unknownInFlight.n,
  };

  // ── Margins ──
  // Two views, because they answer different questions:
  //   realised  — on the money actually collected so far
  //   projected — on what the book is worth once every order in flight settles
  // Cost is only counted once a piece is actually produced, and production
  // starts on full payment — so an order still sitting on its deposit brings
  // in revenue without yet costing anything. Counting its cost early would
  // show a loss on money that is doing exactly what it should.
  const settings = getSettings();
  const feePct = Number.parseFloat(settings.stripe_fee_percent) || 0;
  const feeFixed = Number.parseInt(settings.stripe_fee_fixed_cents, 10) || 0;
  const feeOn = (cents, payments) => Math.round(cents * (feePct / 100)) + feeFixed * payments;

  // Per-order cost wins when set; otherwise the catalogue's cost for that
  // piece, bonus included. Unknown stays null — never zero.
  const defaultCostFor = (productType) => productCostCents(productType);
  const effectiveCost = (o) => (o.cost_cents != null ? o.cost_cents : defaultCostFor(o.product_type));

  const produced = db.prepare(`
    SELECT id, cost_cents, product_type, revision,
           deposit_amount_cents AS dep, balance_amount_cents AS bal
    FROM orders
    WHERE deposit_status = 'paid' AND balance_status = 'paid'
    ${within('balance_paid_at')}
  `).all();

  // Remakes and alterations are money out with nothing extra coming in, so
  // they belong in the margin. A margin that ignores its own failures is a
  // sales figure wearing a margin's name.
  const incidents = incidentsFor(produced.map((o) => o.id));
  const afterSales = afterSalesCost(
    produced.map((o) => ({ revision: o.revision, alterations: incidents.get(o.id) || [] })),
    settings,
  );

  let producedCostCents = 0, producedOrders = 0, producedMissingCost = 0;
  let perOrderGrossSum = 0, perOrderNetSum = 0;
  for (const o of produced) {
    const cost = effectiveCost(o);
    if (cost == null) { producedMissingCost += 1; continue; }
    producedOrders += 1;
    producedCostCents += cost;
    const total = (o.dep || 0) + (o.bal || 0);
    const own = afterSalesCost(
      [{ revision: o.revision, alterations: incidents.get(o.id) || [] }], settings,
    ).cents;
    perOrderGrossSum += total - cost - own;
    perOrderNetSum += total - cost - own - feeOn(total, 2);
  }

  // Stripe takes its cut per payment, so the fixed part is counted once for
  // each deposit and each balance actually collected in the period.
  const collectedCents = deposits.cents + balances.cents;
  const collectedFeesCents = feeOn(deposits.cents, deposits.n) + feeOn(balances.cents, balances.n);
  const realisedGross = collectedCents - producedCostCents - afterSales.cents;
  const realisedNet = realisedGross - collectedFeesCents;

  // Projected margin: same orders the projected-revenue figure counts, minus
  // the ones whose cost can't be established — those are dropped from both
  // sides of the calculation rather than counted as pure profit.
  const inFlight = db.prepare(`
    SELECT cost_cents, product_type, balance_status,
           deposit_amount_cents AS dep, balance_amount_cents AS bal,
           quoted_total_cents AS quoted
    FROM orders
    WHERE deposit_status = 'paid'
      AND (balance_status IN ('link_created','paid')
           OR (balance_status = 'not_created' AND quoted_total_cents IS NOT NULL))
  `).all();

  let projRevenue = 0, projCost = 0, projFees = 0, projOrders = 0, projMissingCost = 0;
  for (const o of inFlight) {
    const cost = effectiveCost(o);
    if (cost == null) { projMissingCost += 1; continue; }
    const total = o.balance_status === 'not_created'
      ? (o.quoted || 0)
      : (o.dep || 0) + (o.bal || 0);
    projOrders += 1;
    projRevenue += total;
    projCost += cost;
    projFees += feeOn(total, 2);
  }
  const projGross = projRevenue - projCost;
  const projNet = projGross - projFees;

  const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : null);

  res.json({
    period,
    collected: {
      deposits: { count: deposits.n, cents: deposits.cents },
      balances: { count: balances.n, cents: balances.cents },
      totalCents: deposits.cents + balances.cents,
    },
    outstanding: { count: outstanding.n, cents: outstanding.cents },
    projected: {
      count: projected.n, cents: projected.cents,
      quotedCount: projected.quotedCount, unknownCount: projected.unknownCount,
    },
    margin: {
      // On the money already in the bank.
      realised: {
        revenueCents: collectedCents,
        costCents: producedCostCents,
        afterSalesCents: afterSales.cents,
        afterSalesUnpriced: afterSales.unpriced,
        feesCents: collectedFeesCents,
        grossCents: realisedGross,
        netCents: realisedNet,
        grossPct: pct(realisedGross, collectedCents),
        netPct: pct(realisedNet, collectedCents),
        producedOrders,
        ordersMissingCost: producedMissingCost,
      },
      // On everything in flight, once it all settles.
      projected: {
        revenueCents: projRevenue,
        costCents: projCost,
        feesCents: projFees,
        grossCents: projGross,
        netCents: projNet,
        grossPct: pct(projGross, projRevenue),
        netPct: pct(projNet, projRevenue),
        orders: projOrders,
        ordersMissingCost: projMissingCost,
      },
      // What one finished piece actually leaves — the unit economics, averaged
      // over orders that are fully paid and produced.
      perOrder: {
        orders: producedOrders,
        grossCents: producedOrders ? Math.round(perOrderGrossSum / producedOrders) : null,
        netCents: producedOrders ? Math.round(perOrderNetSum / producedOrders) : null,
      },
    },
    orders: {
      fullyPaid: fullyPaid.n,
      awaitingBalance: outstanding.n,
      awaitingMeeting: awaitingMeeting.n,
    },
    // Average basket only makes sense on orders with a settled total.
    avgBasketCents: fullyPaid.n ? Math.round(fullyPaid.cents / fullyPaid.n) : 0,
    byMonth: byMonth.reverse(),
  });
});

// Resolves the dashboard's period selector into a SQL date window.
//
// Two ways in: named shortcuts, or an explicit from/to. Explicit dates win —
// if someone typed a range, that is the range, and silently widening it to a
// named period would be answering a different question.
//
// Dates are validated against a strict YYYY-MM-DD shape before being inlined:
// they arrive from the query string, and a date is not a place to be relaxed
// about what reaches SQL.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function resolvePeriod(query) {
  const from = ISO_DATE.test(query.from || '') ? query.from : null;
  const to = ISO_DATE.test(query.to || '') ? query.to : null;
  if (from || to) {
    return {
      label: 'custom', from, to,
      // BETWEEN would need both bounds; separate comparisons let one side be
      // open, which is what "from the 10th onwards" means.
      within: (col) => [
        from ? `AND date(${col}) >= '${from}'` : '',
        to ? `AND date(${col}) <= '${to}'` : '',
      ].join(' '),
    };
  }

  const period = (query.period || 'month').toString();
  const NAMED = {
    today: "date('now')",
    week: "date('now','weekday 0','-6 days')",
    month: "date('now','start of month')",
    quarter: "date('now','-3 months')",
    half: "date('now','-6 months')",
    year: "date('now','start of year')",
    year12: "date('now','-12 months')",
  };
  if (period === 'all') return { label: 'all', from: null, to: null, within: () => '' };
  const start = NAMED[period] || NAMED.month;
  return {
    label: NAMED[period] ? period : 'month',
    from: null, to: null,
    within: (col) => `AND date(${col}) >= ${start}`,
  };
}

// GET /api/orders/workshop-stats — how long each hand-off actually takes,
// from the client's fitting call to the piece landing on their doorstep.
//
// The first two legs are Luc's own doing, the last four depend on the workshop
// and the carrier. The UI greys the first two out for exactly that reason: a
// slow week on either side means very different things, and averaging them
// into one "lead time" would hide which side is slow.
//   meeting    the fitting call started → the order was closed. How long
//              taking an order actually takes.
//   toWorkshop closed → docket sent. Luc's own turnaround, the one delay
//              nobody else can be blamed for.
// Then the four that leave his hands:
//   docket     sent → the workshop opened the docket. MEASURED: the timestamp
//              comes from the docket being fetched from its link, not from
//              anyone declaring anything.
//   production opened → 'Ready'. Luc sets Ready by hand when the workshop
//              tells him the piece is finished.
//   handover   Ready → 'Shipped', i.e. how long the finished piece waits for
//              the carrier to actually take it.
//   transit    Shipped → 'Received' by the client.
// Averaged over completed legs only. An order still mid-leg contributes
// nothing to the average and is counted in `pending` instead: folding a
// running leg in as if it were finished would drag every average towards zero
// and make a slow step look fast.
router.get('/workshop-stats', (_req, res) => {
  // No WHERE filter: an order that never reached the workshop still has a
  // meeting worth timing. Legs whose start is missing contribute nothing at
  // all, so widening the query cannot distort the workshop's own averages.
  const rows = db.prepare(`
    SELECT a.starts_at AS met, o.finalized_at AS closed,
           o.sent_to_workshop_at AS sent, o.workshop_ack_at AS opened,
           o.ready_at AS ready, o.shipped_at AS shipped, o.received_at AS received
    FROM orders o
    LEFT JOIN appointments a ON a.id = o.appointment_id
  `).all();

  const days = (from, to) => {
    if (!from || !to) return null;
    const a = new Date(from).getTime(), b = new Date(to).getTime();
    // A negative span means the two stamps were entered out of order — real,
    // and better dropped than averaged in as a negative lead time.
    if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
    return (b - a) / 86400000;
  };

  const LEGS = [
    ['meeting', 'met', 'closed'],
    ['toWorkshop', 'closed', 'sent'],
    ['docket', 'sent', 'opened'],
    ['production', 'opened', 'ready'],
    ['handover', 'ready', 'shipped'],
    ['transit', 'shipped', 'received'],
  ];

  const acc = Object.fromEntries(LEGS.map(([k]) => [k, { spans: [], pending: 0 }]));
  const totals = [];
  for (const r of rows) {
    for (const [key, from, to] of LEGS) {
      const d = days(r[from], r[to]);
      if (d != null) acc[key].spans.push(d);
      // Only counts as pending once the leg has actually started.
      else if (r[from]) acc[key].pending += 1;
    }
    const t = days(r.sent, r.received);
    if (t != null) totals.push(t);
  }
  const ordersSent = rows.filter((r) => r.sent).length;

  const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null);
  const legs = Object.fromEntries(
    LEGS.map(([k]) => [k, { avgDays: avg(acc[k].spans), n: acc[k].spans.length, pending: acc[k].pending }]),
  );

  res.json({ legs, total: { avgDays: avg(totals), n: totals.length }, ordersSent });
});

// What a failed piece actually cost. Two components, deliberately separate
// because only one has a known price today:
//   redo       — a whole second piece, at a flat cost Luc bears (settings)
//   alteration — a seamstress and a return shipment; no standard price yet, so
//                only alterations with their own cost_cents count, and the
//                rest are reported as "cost unknown" rather than as free.
// Returns cents plus how many incidents could not be priced, so no caller can
// present the figure as complete when it isn't.
function afterSalesCost(rows, settings) {
  const redoCost = Number.parseInt(settings.redo_cost_cents, 10);
  const stdAlteration = Number.parseInt(settings.alteration_cost_cents, 10);
  const hasRedoCost = Number.isInteger(redoCost) && redoCost > 0;
  const hasStdAlteration = Number.isInteger(stdAlteration) && stdAlteration > 0;

  let cents = 0, unpriced = 0, redos = 0, alterations = 0;
  for (const r of rows) {
    // revision 2 means the piece was made twice: one extra piece, not two.
    const extraRounds = Math.max(0, (r.revision || 1) - 1);
    redos += extraRounds;
    if (extraRounds) {
      if (hasRedoCost) cents += extraRounds * redoCost;
      else unpriced += extraRounds;
    }
    for (const a of r.alterations || []) {
      alterations += 1;
      if (a.cost_cents != null) cents += a.cost_cents;
      else if (hasStdAlteration) cents += stdAlteration;
      else unpriced += 1;
    }
  }
  return { cents, unpriced, redos, alterations };
}

// Loads the incidents attached to a set of orders in one query.
function incidentsFor(orderIds) {
  if (!orderIds.length) return new Map();
  const placeholders = orderIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT order_id, cost_cents FROM order_alterations WHERE order_id IN (${placeholders})
  `).all(...orderIds);
  const byOrder = new Map();
  for (const r of rows) {
    if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, []);
    byOrder.get(r.order_id).push(r);
  }
  return byOrder;
}

// GET /api/orders/aftersales-stats — the alteration rate, i.e. how often a
// finished piece was not right first time.
//
// The denominator is the only interesting decision here: it counts pieces the
// client has actually received, because a suit still at the workshop cannot
// yet have needed a retouch. Dividing by all orders would flatter the rate by
// padding it with pieces that have not been judged yet — which is exactly the
// number you do not want to reassure yourself with.
//
// Two failure modes, kept apart because they cost very differently:
//   alteration — a local seamstress adjusts the piece
//   redo       — the piece is remade from scratch (orders.revision > 1)
router.get('/aftersales-stats', (_req, res) => {
  // 'received' is the first stage at which the client has the piece in hand.
  const RECEIVED_ONWARDS = PRODUCTION_STAGES.slice(PRODUCTION_STAGES.indexOf('received'));
  const placeholders = RECEIVED_ONWARDS.map(() => '?').join(',');

  const rows = db.prepare(`
    SELECT o.id, o.order_number, o.revision, o.production_status,
           (SELECT COUNT(*) FROM order_alterations a WHERE a.order_id = o.id) AS alterations
    FROM orders o
    WHERE o.production_status IN (${placeholders}) OR o.received_at IS NOT NULL
  `).all(...RECEIVED_ONWARDS);

  const delivered = rows.length;
  const withAlteration = rows.filter((r) => r.alterations > 0).length;
  const withRedo = rows.filter((r) => (r.revision || 1) > 1).length;
  // An order can have been both remade and then adjusted; counted once here so
  // "first time right" stays a share of pieces, not of incidents.
  const anyIssue = rows.filter((r) => r.alterations > 0 || (r.revision || 1) > 1).length;

  // Why pieces come back. Free text typed by Luc, so it is grouped
  // case-insensitively and shown as written — never invented into categories.
  const reasons = db.prepare(`
    SELECT TRIM(reason) AS reason, COUNT(*) AS n
    FROM order_alterations
    WHERE reason IS NOT NULL AND TRIM(reason) != ''
    GROUP BY LOWER(TRIM(reason))
    ORDER BY n DESC
    LIMIT 8
  `).all();

  const settings = getSettings();
  const incidents = incidentsFor(rows.map((r) => r.id));
  const cost = afterSalesCost(
    rows.map((r) => ({ revision: r.revision, alterations: incidents.get(r.id) || [] })),
    settings,
  );

  const pct = (n) => (delivered ? Math.round((n / delivered) * 100) : null);
  res.json({
    lossCents: cost.cents,
    lossUnpriced: cost.unpriced,
    redoUnitCents: Number.parseInt(settings.redo_cost_cents, 10) || null,
    alterationUnitCents: Number.parseInt(settings.alteration_cost_cents, 10) || null,
    delivered,
    withAlteration,
    withRedo,
    anyIssue,
    firstTimeRight: delivered - anyIssue,
    alterationRate: pct(withAlteration),
    redoRate: pct(withRedo),
    firstTimeRightRate: pct(delivered - anyIssue),
    reasons,
    // Pieces still in the pipeline, stated so the rate is never read as
    // covering the whole book.
    notYetReceived: db.prepare(`
      SELECT COUNT(*) AS n FROM orders
      WHERE deposit_status = 'paid' AND received_at IS NULL
        AND production_status NOT IN (${placeholders})
    `).get(...RECEIVED_ONWARDS).n,
  });
});

// GET /api/orders/product-mix — what actually sells, over the selected period.
//
// Money is attributed exactly as the revenue figures are: a deposit counts in
// the period it cleared, a balance in the period it cleared. So the sum of the
// products here always equals "Collected" for the same window — two numbers on
// one screen that disagree are worse than one number.
//
// Units are counted on the deposit: a piece is sold the day someone pays to
// reserve it, not the day they settle the rest.
router.get('/product-mix', (req, res) => {
  const range = resolvePeriod(req.query);
  const within = range.within;

  const rows = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(product_type), ''), 'inconnu') AS type,
           SUM(CASE WHEN deposit_status = 'paid' ${within('deposit_paid_at')} THEN 1 ELSE 0 END) AS units,
           SUM(CASE WHEN deposit_status = 'paid' ${within('deposit_paid_at')}
                    THEN COALESCE(deposit_amount_cents, 0) ELSE 0 END) AS deposits,
           SUM(CASE WHEN balance_status = 'paid' ${within('balance_paid_at')}
                    THEN COALESCE(balance_amount_cents, 0) ELSE 0 END) AS balances
    FROM orders
    GROUP BY type
  `).all();

  // The catalogue is listed in full, zeros included: "we sold no blazers this
  // month" is a finding, and a row that vanishes when it hits zero is the one
  // row you needed to see. Order comes from the catalogue itself.
  const cat = catalogue();
  const order = new Map(cat.map((p, i) => [p.key, i]));
  const bySold = new Map(rows.map((r) => [r.type, r]));
  const types = [...new Set([...cat.map((p) => p.key), ...rows.map((r) => r.type)])];

  const products = types
    .map((type) => {
      const r = bySold.get(type);
      const meta = cat.find((p) => p.key === type);
      return {
        type,
        label: meta ? meta.label : (type === 'inconnu' ? 'Non renseigné' : type),
        units: r ? r.units : 0,
        revenueCents: r ? r.deposits + r.balances : 0,
        inCatalogue: !!meta,
      };
    })
    // A stray product type with no sales isn't catalogue — drop it rather than
    // pad the list with historical typos.
    .filter((p) => p.inCatalogue || p.units > 0 || p.revenueCents > 0)
    .sort((a, b) =>
      b.revenueCents - a.revenueCents
      || b.units - a.units
      // Ties (usually all-zero rows) keep catalogue order rather than falling
      // into whatever order SQLite happened to return.
      || (order.get(a.type) ?? 99) - (order.get(b.type) ?? 99));

  const totalCents = products.reduce((a, b) => a + b.revenueCents, 0);
  const totalUnits = products.reduce((a, b) => a + b.units, 0);

  res.json({
    period: range.label,
    from: range.from,
    to: range.to,
    products: products.map((p) => ({
      ...p,
      // Share of money, not of units: two shirts and one suit are not an
      // even split of anything that matters.
      pct: totalCents ? Math.round((p.revenueCents / totalCents) * 100) : 0,
    })),
    totalCents,
    totalUnits,
  });
});

// GET /api/orders/production-board — the CRM's Orders page. Human-authenticated
// (behind Basic Auth), so it can return the whole book rather than one client's
// slice.
//
// What counts as an order is the important decision here. The website only
// takes a deposit; it does not produce an order. The piece is actually
// specified during the fitting call, and only when that call is closed does a
// docket exist to send anywhere. So the board shows finalized orders — and
// nothing else, because a row offering "send to the workshop" on a
// half-configured piece is an invitation to send the workshop a spec nobody
// agreed to.
//
// Two other populations exist and are reachable with ?scope=:
//   pre_meeting — deposit paid or appointment booked, call not held yet. Real
//                 people with money down; visible so they are never forgotten,
//                 but with no production actions attached.
//   Abandoned checkouts (no deposit, no appointment) appear in neither: they
//   are leads, and they live on the client's own file.
//
// Only `finished` is hidden by default within the production scope — the board
// is a to-do list, and closed work pushing live work off the screen is how
// things get forgotten. `delivered` stays visible on purpose: it means the
// client's verdict is still pending, which is an open task, not a completed one.
router.get('/production-board', (req, res) => {
  const includeDelivered = req.query.includeDelivered === '1';
  const scope = req.query.scope === 'pre_meeting' ? 'pre_meeting' : 'production';

  const scopeWhere = scope === 'pre_meeting'
    ? `o.finalized_at IS NULL AND (o.deposit_status = 'paid' OR o.appointment_id IS NOT NULL)`
    : `o.finalized_at IS NOT NULL`;
  const rows = db.prepare(`
    SELECT o.id, o.order_number, o.product_type, o.status,
           o.deposit_status, o.balance_status,
           o.deposit_amount_cents, o.balance_amount_cents,
           o.production_status, o.workshop_deadline, o.production_notes,
           o.revision, o.production_history,
           o.recap_email_sent_at, o.balance_reminder_1_sent_at, o.balance_reminder_2_sent_at,
           o.sent_to_workshop_at, o.in_production_at, o.ready_at,
           o.shipped_at, o.received_at, o.delivered_at, o.carrier, o.tracking_number,
           o.cost_cents, o.quoted_total_cents,
           o.workshop_ack_at, o.workshop_reminder_sent_at,
           o.config_json, o.shop_config_json, c.measurements_json,
           o.finalized_at, a.starts_at AS appointment_at,
           o.created_at,
           c.id AS client_id, c.first_name, c.last_name, c.email, c.address
    FROM orders o
    JOIN clients c ON c.id = o.client_id
    LEFT JOIN appointments a ON a.id = o.appointment_id
    WHERE ${scopeWhere}
      ${includeDelivered || scope === 'pre_meeting' ? '' : "AND o.production_status != 'finished'"}
    ORDER BY
      CASE WHEN o.workshop_deadline IS NULL THEN 1 ELSE 0 END,
      o.workshop_deadline ASC,
      o.created_at DESC
  `).all();

  // Alterations for the whole page in one query rather than per row — the
  // board renders every order's current round inline, and N+1 here would mean
  // one round-trip per order on every refresh.
  const alterations = db.prepare(`
    SELECT * FROM order_alterations ORDER BY round ASC, created_at ASC
  `).all();
  const byOrder = alterations.reduce((acc, a) => {
    (acc[a.order_id] ||= []).push(a);
    return acc;
  }, {});

  const now = new Date();
  // Derived per request rather than stored: the size chart will be edited, and
  // a size written onto an order would quietly become wrong the moment it is.
  const standards = db.prepare('SELECT * FROM size_standards ORDER BY sort_order ASC, label ASC').all()
    .map((r) => ({ ...r, ranges: parseRanges(r.ranges_json) }));

  res.json({
    data: rows.map((r) => {
      const { config_json, shop_config_json, measurements_json, ...row } = r;
      const hit = matchSize(measurementsForOrder({
        configJson: config_json,
        shopConfigJson: shop_config_json,
        clientMeasurementsJson: measurements_json,
      }), standards);
      return {
        ...row,
        is_late: isLate(r, now),
        alterations: byOrder[r.id] || [],
        standard_size: hit ? { label: hit.label, exact: hit.exact } : null,
      };
    }),
    scope,
    // So the UI can offer the other scope without pretending it is empty.
    counts: {
      preMeeting: db.prepare(`
        SELECT COUNT(*) AS n FROM orders o
        WHERE o.finalized_at IS NULL
          AND (o.deposit_status = 'paid' OR o.appointment_id IS NOT NULL)
      `).get().n,
    },
    stages: PRODUCTION_STAGES,
    labels: PRODUCTION_LABELS,
    alterationStatuses: ALTERATION_STATUSES,
    alterationLabels: ALTERATION_LABELS,
    // Standard production cost per piece, so the per-order cost field can show
    // what will be used if it's left blank — an empty field that still counts
    // towards margin would otherwise look like a gap.
    costDefaults: Object.fromEntries(
      catalogue()
        .filter((p) => p.cost_cny != null)
        .map((p) => [p.key, p.costWithBonusCents]),
    ),
    // Distinct seamstresses already used, so the UI can offer them instead of
    // making Luc retype the same address for every client in the same city.
    seamstresses: db.prepare(`
      SELECT seamstress_name AS name, seamstress_address AS address, seamstress_phone AS phone,
             MAX(created_at) AS last_used
      FROM order_alterations
      WHERE seamstress_name IS NOT NULL AND seamstress_name != ''
      GROUP BY seamstress_name, seamstress_address, seamstress_phone
      ORDER BY last_used DESC
      LIMIT 20
    `).all(),
  });
});

// POST /api/orders/:id/redo — the client isn't happy and the piece has to be
// remade. Deliberately NOT a new order: the client paid once and is owed one
// finished piece, so revenue, invoice and history stay on this row and only
// the production cycle restarts, with revision bumped.
router.post('/:id/redo', (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const { reason } = req.body || {};

    // Archive the round that just failed before wiping it, so the timeline of
    // what actually happened survives the restart.
    const history = JSON.parse(order.production_history || '[]');
    history.push({
      revision: order.revision || 1,
      reason: reason || null,
      closed_at: new Date().toISOString(),
      sent_to_workshop_at: order.sent_to_workshop_at,
      in_production_at: order.in_production_at,
      ready_at: order.ready_at,
      shipped_at: order.shipped_at,
      received_at: order.received_at,
      delivered_at: order.delivered_at,
      carrier: order.carrier,
      tracking_number: order.tracking_number,
    });

    db.prepare(`
      UPDATE orders SET
        revision = ?, production_history = ?, production_status = 'not_started',
        ${ROUND_RESET_COLUMNS.map((c) => `${c} = NULL`).join(', ')},
        updated_at = datetime('now')
      WHERE id = ?
    `).run((order.revision || 1) + 1, JSON.stringify(history), order.id);

    logMessage(order.client_id, 'note',
      `REFAIRE — commande ${order.order_number || order.id} repart en production (version ${(order.revision || 1) + 1})`
      + (reason ? `\n\nMotif : ${reason}` : ''));

    const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    res.json({ ok: true, order: { ...updated, is_late: isLate(updated), alterations: [] } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/orders/:id/alterations — client needs the piece adjusted. Opens a
// new round and parks the order in `in_alteration` until it's shipped back.
router.post('/:id/alterations', (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const { reason } = req.body || {};
    const lastRound = db.prepare(
      'SELECT MAX(round) AS r FROM order_alterations WHERE order_id = ?'
    ).get(order.id).r || 0;

    const id = randomUUID();
    db.prepare(`
      INSERT INTO order_alterations (id, order_id, client_id, round, reason, status)
      VALUES (?, ?, ?, ?, ?, 'needed')
    `).run(id, order.id, order.client_id, lastRound + 1, reason || null);

    db.prepare("UPDATE orders SET production_status = 'in_alteration', updated_at = datetime('now') WHERE id = ?")
      .run(order.id);

    logMessage(order.client_id, 'note',
      `RETOUCHE — commande ${order.order_number || order.id}, tour ${lastRound + 1}`
      + (reason ? `\n\nMotif : ${reason}` : ''));

    const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    const rounds = db.prepare('SELECT * FROM order_alterations WHERE order_id = ? ORDER BY round').all(order.id);
    res.status(201).json({ ok: true, order: { ...updated, is_late: isLate(updated), alterations: rounds } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/orders/alterations/:alterationId — advance the alteration or fill
// in the seamstress. Reaching `shipped_back` puts the order back to
// `delivered`: the piece is with the client again and the verdict is pending,
// which is exactly what `delivered` means here.
router.patch('/alterations/:alterationId', (req, res) => {
  try {
    const alt = db.prepare('SELECT * FROM order_alterations WHERE id = ?').get(req.params.alterationId);
    if (!alt) return res.status(404).json({ error: 'Alteration not found' });

    const { status, reason, seamstressName, seamstressAddress, seamstressPhone, notes } = req.body || {};
    if (status !== undefined && !isValidAlterationStatus(status)) {
      return res.status(400).json({ error: `Unknown alteration status: ${status}` });
    }

    const sets = [];
    const vals = [];
    const push = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };
    if (reason !== undefined) push('reason', reason || null);
    if (seamstressName !== undefined) push('seamstress_name', seamstressName || null);
    if (seamstressAddress !== undefined) push('seamstress_address', seamstressAddress || null);
    if (seamstressPhone !== undefined) push('seamstress_phone', seamstressPhone || null);
    if (notes !== undefined) push('notes', notes || null);

    const movingTo = status !== undefined && status !== alt.status ? status : null;
    if (movingTo) {
      push('status', movingTo);
      const tsCol = ALTERATION_TIMESTAMP_COLUMN[movingTo];
      if (tsCol && !alt[tsCol]) push(tsCol, new Date().toISOString());
    }

    if (sets.length) {
      db.prepare(`UPDATE order_alterations SET ${sets.join(', ')} WHERE id = ?`).run(...vals, alt.id);
    }

    if (movingTo === 'shipped_back') {
      db.prepare("UPDATE orders SET production_status = 'delivered', updated_at = datetime('now') WHERE id = ?")
        .run(alt.order_id);
    }

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(alt.order_id);
    const rounds = db.prepare('SELECT * FROM order_alterations WHERE order_id = ? ORDER BY round').all(alt.order_id);
    res.json({ ok: true, order: { ...order, is_late: isLate(order), alterations: rounds } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/orders/alterations/:alterationId/send-details — emails the client
// where to drop the piece off. Manual by design: the surrounding conversation
// with an unhappy client is Luc's, but the address is genuinely better in
// writing than repeated over the phone.
router.post('/alterations/:alterationId/send-details', async (req, res) => {
  try {
    const alt = db.prepare('SELECT * FROM order_alterations WHERE id = ?').get(req.params.alterationId);
    if (!alt) return res.status(404).json({ error: 'Alteration not found' });
    if (!alt.seamstress_name || !alt.seamstress_address) {
      return res.status(400).json({ error: 'Add the seamstress name and address first' });
    }

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(alt.order_id);
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(alt.client_id || order.client_id);
    if (!client?.email) return res.status(400).json({ error: 'Client has no email address' });

    const settings = getSettings();
    const vars = {
      first_name: client.first_name || '',
      product_label: productLabel(order.product_type),
      order_reference: order.order_number || order.id,
      seamstress_name: alt.seamstress_name,
      seamstress_address: alt.seamstress_address,
      seamstress_phone: alt.seamstress_phone || '',
      signature: settings.email_signature || '',
    };
    const subject = renderTemplate(settings.alteration_details_subject, vars);
    const text = renderTemplate(settings.alteration_details_body, vars);
    const sent = await sendEmail({ to: client.email, subject, text, html: wrapHtml(text) });
    if (!sent.ok) return res.status(500).json({ error: sent.error || 'Email send failed' });

    logMessage(client.id, 'note', `${subject}\n\n${text}`);
    res.json({ ok: true, sentTo: client.email });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/orders/:id/production — the one write the Orders page makes.
// Human-authenticated. Advancing into a client-facing stage sends that
// stage's email exactly once (production_emails_sent), so correcting a
// mis-clicked status never re-notifies the client.
router.patch('/:id/production', async (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const { productionStatus, workshopDeadline, productionNotes, carrier, trackingNumber, costCents } = req.body || {};
    if (productionStatus !== undefined && !isValidStage(productionStatus)) {
      return res.status(400).json({ error: `Unknown production status: ${productionStatus}` });
    }

    const sets = [];
    const vals = [];
    const push = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };

    if (workshopDeadline !== undefined) push('workshop_deadline', workshopDeadline || null);
    if (productionNotes !== undefined) push('production_notes', productionNotes || null);
    if (carrier !== undefined) push('carrier', carrier || null);
    if (trackingNumber !== undefined) push('tracking_number', trackingNumber || null);
    // An empty string clears the cost back to "unknown" rather than setting
    // it to 0 — the two mean very different things for the margin figure.
    if (costCents !== undefined) {
      const n = Number.parseInt(costCents, 10);
      push('cost_cents', Number.isInteger(n) && n >= 0 ? n : null);
    }

    const movingTo = productionStatus !== undefined && productionStatus !== order.production_status
      ? productionStatus
      : null;
    if (movingTo) {
      push('production_status', movingTo);
      // Stamp the stage's timestamp only the first time it's reached, so a
      // back-and-forth correction doesn't rewrite the real history.
      const tsCol = STAGE_TIMESTAMP_COLUMN[movingTo];
      if (tsCol && !order[tsCol]) push(tsCol, new Date().toISOString());
    }

    if (sets.length) {
      push('updated_at', new Date().toISOString());
      db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...vals, order.id);
    }

    // Client notification — best-effort and never fatal: the status change is
    // already committed above, and failing the whole request over an email
    // would leave Luc thinking the move didn't happen.
    let emailed = null;
    const emailStage = movingTo && CLIENT_EMAIL_STAGES[movingTo];
    if (emailStage) {
      const alreadySent = JSON.parse(order.production_emails_sent || '[]');
      if (!alreadySent.includes(movingTo)) {
        try {
          const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(order.client_id);
          const settings = getSettings();
          const fresh = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
          const tplVars = {
            first_name: client?.first_name || '',
            product_label: productLabel(fresh.product_type),
            order_reference: fresh.order_number || fresh.id,
            carrier: fresh.carrier || '—',
            tracking_number: fresh.tracking_number || '—',
            signature: settings.email_signature || '',
          };
          const subject = renderTemplate(settings[emailStage.subjectKey], tplVars);
          const text = renderTemplate(settings[emailStage.bodyKey], tplVars);
          if (client?.email) {
            const sent = await sendEmail({ to: client.email, subject, text, html: wrapHtml(text) });
            if (sent.ok) {
              db.prepare('UPDATE orders SET production_emails_sent = ? WHERE id = ?')
                .run(JSON.stringify([...alreadySent, movingTo]), order.id);
              logMessage(order.client_id, 'note', `${subject}\n\n${text}`);
              emailed = movingTo;
            }
          }
        } catch (e) {
          console.error('[orders/production] client email failed (non-fatal):', e.message);
        }
      }
    }

    const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    res.json({ ok: true, emailed, order: { ...updated, is_late: isLate(updated) } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/orders?clientId=... — human-authenticated (behind Traefik Basic
// Auth, not in the public router allowlist), used by the CRM's Client detail
// panel to list a client's orders and link to their invoices.
router.get('/', (req, res) => {
  const clientId = (req.query.clientId || '').toString().trim();
  if (!clientId) return res.status(400).json({ error: 'clientId is required' });
  const rows = db.prepare(`
    SELECT id, order_number, product_type, status,
           deposit_amount_cents, deposit_status,
           balance_amount_cents, balance_status,
           created_at
    FROM orders WHERE client_id = ? ORDER BY created_at DESC
  `).all(clientId);
  res.json({ data: rows });
});

// POST /api/orders/:id/send-docket — the same send, triggered from the CRM.
// Until now the docket could only leave from the stylist tool, which meant the
// board could say "at workshop" while the workshop had received nothing. Not
// behind requireIntakeSecret: this one is Luc clicking in his own
// Basic-Auth-protected CRM, the same trust boundary as the invoice PDF below.
router.post('/:id/send-docket', async (req, res) => {
  try {
    const { status, body } = await sendDocketToWorkshop(req.params.id);
    if (status !== 200) return res.status(status).json(body);
    // The board row is re-read after the send so the caller gets the new stage
    // and timestamp without a second round trip.
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    res.json({ ...body, order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/orders/:id/remind-workshop — chases an unopened docket. Refused
// once the workshop has actually opened it: chasing someone who already
// answered is how a supplier starts ignoring your emails.
router.post('/:id/remind-workshop', async (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.sent_to_workshop_at) {
      return res.status(409).json({ error: "Le bon n'a pas encore été envoyé" });
    }
    if (order.workshop_ack_at) {
      return res.status(409).json({ error: "L'atelier a déjà ouvert le bon" });
    }

    const { status, body } = await sendDocketToWorkshop(req.params.id, 'reminder');
    if (status !== 200) return res.status(status).json(body);
    res.json({ ...body, order: db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/orders/:id/email-preview?stage=recap|reminder1|reminder2 — renders
// the exact email a client receives, without sending anything. Same rationale
// as the invoice route below: meant to be opened in Luc's browser (protected
// by Basic Auth at the edge), not called server-to-server. The activity log
// keeps the plain-text copy of what went out; this shows the designed version,
// including for reminders that haven't fired yet.
router.get('/:id/email-preview', (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const stage = (req.query.stage || 'recap').toString();
    if (!BALANCE_EMAIL_STAGES[stage]) {
      return res.status(400).json({ error: `Unknown stage: ${stage}` });
    }

    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(order.client_id);
    const { subject, html } = buildBalanceEmail({ stage, order, client, settings: getSettings() });

    // A thin banner above the email itself — without it there's no way to tell
    // a preview from a real inbox screenshot, and the subject line (which the
    // client does see) would otherwise be invisible here.
    const banner = `
      <div style="font-family:sans-serif;background:#1a1410;color:#fff;padding:12px 18px;font-size:13px;">
        <strong>Aperçu</strong> — rien n'est envoyé ·
        objet : <em>${subject.replace(/</g, '&lt;')}</em>
      </div>`;
    res.set('Content-Type', 'text/html; charset=utf-8').send(banner + html);
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

// GET /api/orders/:id/production-order.pdf — same auth pattern as invoice.pdf
// (Traefik Basic Auth at the edge, not requireIntakeSecret): the workshop
// docket (measurements, jacket/trousers construction, no price), previously
// only ever generated once at /finalize and emailed to
// production_order_notify_email — the stylist had no way to re-fetch it
// afterwards. Uses whatever config_json/shop_config_summary the order has
// right now, so it reflects the latest finalized config.
router.get('/:id/production-order.pdf', async (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(order.client_id);
    const pdfBuffer = await buildProductionOrderPdf({
      order,
      client,
      config: JSON.parse(order.config_json || '{}'),
      shopConfigSummary: JSON.parse(order.shop_config_summary || '[]'),
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="bon-de-commande-${order.order_number || order.id}.pdf"`);
    res.send(pdfBuffer);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/orders/:id/production-order.xlsx — same on-demand-rebuild pattern
// as the PDF above, Luc's own standardized order form (lib/xlsx.js) instead
// of the CJK recap layout.
router.get('/:id/production-order.xlsx', async (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(order.client_id);
    const xlsxBuffer = await buildTailoringOrderXlsx({
      order, client, config: JSON.parse(order.config_json || '{}'),
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="bon-de-commande-${order.order_number || order.id}.xlsx"`);
    res.send(xlsxBuffer);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
