import { Router } from 'express';
import { randomUUID, randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import db from '../db.js';
import { verifyWebhookSignature } from '../lib/stripe.js';
import { buildThankYouEmail } from '../lib/balanceEmails.js';
import { sendEmail, renderTemplate, wrapHtml } from '../lib/email.js';
import { getSettings } from './settings.js';
import { formatMoney, logMessage, productLabel } from '../lib/orderHelpers.js';
import { extractFathomFields, matchFathomCall, storeFathomCall, verifyFathomSignature } from '../lib/fathom.js';
import { redeemUrl } from './giftCards.js';

const router = Router();

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Bespoke HTML rather than the generic wrapHtml() text wrapper (like
// workshopEmailHtml in routes/orders.js) — this is the one email in the
// system that needs to embed an image, the QR code the beneficiary scans.
// A base64 data: URI rather than a Resend attachment + cid: reference:
// simpler, and every mainstream client (Gmail, Apple Mail, Outlook web)
// renders a QR-sized data URI fine.
function giftCardEmailHtml({ text, qrDataUrl, redeemUrl }) {
  const paragraphs = escapeHtml(text)
    .split('\n\n')
    .filter((p) => p.trim())
    .map((p) => `<p style="margin:0 0 16px;white-space:pre-line;">${p}</p>`)
    .join('');
  return `<div style="font-family:sans-serif;max-width:480px;color:#1A1A1A;line-height:1.5;">
    ${paragraphs}
    <div style="text-align:center;margin:24px 0;padding:24px;border:1px solid #e5e0da;">
      <img src="${qrDataUrl}" width="220" height="220" alt="QR code SLY Experience" style="display:block;margin:0 auto 16px;" />
      <a href="${redeemUrl}" style="background:#1A1A1A;color:#fff;padding:12px 24px;text-decoration:none;font-weight:500;display:inline-block;">Voir la carte cadeau</a>
    </div>
  </div>`;
}

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

    // "full_payment" (currently only the shirt — see sly-shop's pricing.ts
    // paymentMode) reuses every bit of the deposit flow below unchanged
    // (shipping capture, tape-measure alert, internal notification) — the
    // amount charged (session.amount_total / order.deposit_amount_cents) is
    // already the real full price for these, sly-shop sent it that way. The
    // one thing that's different — there's no balance to invoice later — is
    // deliberately NOT encoded as a new order status here (kept out of an
    // already-large orders.status state machine this session doesn't have
    // full visibility into); it's inferred instead from product_type being
    // "shirt", the only paymentMode:"full" product as of this writing.
    if (kind === 'deposit' || kind === 'full_payment') {
      const order = db.prepare('SELECT * FROM orders WHERE stripe_checkout_session_id = ?').get(session.id);
      if (!order) {
        console.error(`[stripe-webhook] deposit checkout.session.completed for unknown session ${session.id} — no order was staged via /api/orders/intake`);
      } else if (order.deposit_status !== 'paid') {
        db.prepare(`
          UPDATE orders SET deposit_status = 'paid', status = 'deposit_paid',
            stripe_deposit_payment_intent_id = ?,
            deposit_paid_at = COALESCE(deposit_paid_at, datetime('now')),
            updated_at = datetime('now')
          WHERE id = ?
        `).run(session.payment_intent || null, order.id);
        logMessage(order.client_id, 'deposit_paid', `Deposit paid (${session.amount_total ? (session.amount_total / 100) : '?'} ${session.currency || ''})`);

        // The workshop ships straight to the client — collected as part of
        // the Stripe Checkout page itself (shipping_address_collection, see
        // sly-shop's create-checkout-session route), landing here once the
        // customer actually submits it. Only fills in a client who doesn't
        // already have an address on file, so a stylist's manual correction
        // (see POST /api/clients/set-address) from an earlier order is never
        // silently overwritten by a webhook retry or a second order.
        try {
          // Newer Stripe API versions moved the collected shipping address
          // under collected_information.shipping_details; older ones (and
          // this webhook's payload shape depends on the Stripe account's own
          // pinned API version, which may differ from sly-shop's explicit
          // one) still use a top-level shipping_details. Check both.
          const shipping = session.collected_information?.shipping_details?.address
            || session.shipping_details?.address;
          if (shipping) {
            const client = db.prepare('SELECT address FROM clients WHERE id = ?').get(order.client_id);
            if (client && !client.address) {
              const formatted = [
                shipping.line1, shipping.line2,
                [shipping.postal_code, shipping.city].filter(Boolean).join(' '),
                shipping.state, shipping.country,
              ].filter(Boolean).join(', ');
              if (formatted) db.prepare('UPDATE clients SET address = ? WHERE id = ?').run(formatted, order.client_id);
            }
          }
        } catch (e) {
          console.error('[stripe-webhook] shipping address capture failed (non-fatal):', e.message);
        }

        // Alert Luc to post a tape measure, but only when all three things
        // are true: the deposit is paid (we're inside that branch), the
        // client actually said they don't have one, and we know where to
        // send it. The earlier version checked none of the last two, so it
        // fired for every client — including everyone who answered that they
        // already owned a tape, which made the alert worth ignoring.
        // Wrapped defensively: a bug here must never take down the deposit
        // webhook itself (already recorded above) or crash the process.
        try {
          const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(order.client_id);
          const needsOne = client?.needs_tape_measure === 1;
          const knowsWhere = !!(client?.address && client.address.trim());
          const settings = getSettings();
          if (client && needsOne && knowsWhere && !client.tape_measure_sent_at) {
            const vars = {
              first_name: client.first_name || '',
              last_name: client.last_name || '',
              email: client.email || '',
              address: client.address || 'non renseignée',
              product_label: productLabel(order.product_type),
              order_reference: order.order_number || order.id,
            };
            const subject = renderTemplate(settings.tape_measure_alert_subject, vars);
            const text = renderTemplate(settings.tape_measure_alert_body, vars);
            if (settings.tape_measure_notify_email) {
              await sendEmail({ to: settings.tape_measure_notify_email, subject, text, html: wrapHtml(text) });
            }
          } else if (client && needsOne && !knowsWhere && !client.tape_measure_sent_at) {
            // Shouldn't be reachable through the site (it makes the address
            // mandatory for exactly this answer), but staying silent here
            // would mean the client turns up to the fitting with no tape and
            // no-one ever knew. Distinct subject so it's not mistaken for the
            // normal, actionable alert.
            if (settings.tape_measure_notify_email) {
              const text = `${client.first_name || ''} ${client.last_name || ''} (${client.email || 'sans email'}) `
                + `a besoin d'un mètre ruban mais aucune adresse n'est enregistrée.\n\n`
                + `Commande : ${order.order_number || order.id}\n\n`
                + `Ajoute son adresse sur sa fiche client, puis envoie le ruban.`;
              await sendEmail({
                to: settings.tape_measure_notify_email,
                subject: `Mètre ruban à envoyer — ADRESSE MANQUANTE (${client.first_name || ''} ${client.last_name || ''})`.trim(),
                text,
                html: wrapHtml(text),
              });
            }
          }
        } catch (e) {
          console.error('[stripe-webhook] tape-measure alert failed (non-fatal):', e.message);
        }

        // Internal "you got paid" notification — unconditional, unlike the
        // tape-measure alert above (which only fires for a client's first
        // ever tape measure). Luc reported never getting notified of
        // deposits at all before this.
        try {
          const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(order.client_id);
          const settings = getSettings();
          const vars = {
            first_name: client?.first_name || '',
            last_name: client?.last_name || '',
            email: client?.email || '',
            product_label: productLabel(order.product_type),
            order_reference: order.order_number || order.id,
            deposit_amount: formatMoney(order.deposit_amount_cents, settings.currency),
          };
          const subject = renderTemplate(settings.deposit_received_subject, vars);
          const text = renderTemplate(settings.deposit_received_body, vars);
          if (settings.internal_notify_email) {
            await sendEmail({ to: settings.internal_notify_email, subject, text, html: wrapHtml(text) });
          }
        } catch (e) {
          console.error('[stripe-webhook] deposit-received notification failed (non-fatal):', e.message);
        }
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
            balance_stripe_session_id = ?,
            balance_paid_at = COALESCE(balance_paid_at, datetime('now')),
            updated_at = datetime('now')
          WHERE id = ?
        `).run(session.id, order.id);

        const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(order.client_id);
        const settings = getSettings();

        // One survey row per order, created here so the token exists before
        // the email that carries it. Reused if the webhook is redelivered, so
        // a client can never end up with two live survey links.
        let survey = db.prepare('SELECT * FROM satisfaction_surveys WHERE order_id = ?').get(order.id);
        if (!survey) {
          const token = randomBytes(24).toString('hex');
          db.prepare(`
            INSERT INTO satisfaction_surveys (id, order_id, client_id, token)
            VALUES (?, ?, ?, ?)
          `).run(randomUUID(), order.id, order.client_id, token);
          survey = { token };
        }
        // PUBLIC_URL is what the client's browser can reach; without it the
        // email ships no survey button rather than a link to nowhere.
        const surveyUrl = process.env.PUBLIC_URL
          ? `${process.env.PUBLIC_URL.replace(/\/$/, '')}/survey/${survey.token}`
          : null;

        const { subject, html, text } = buildThankYouEmail({ order, client, settings, surveyUrl });

        let sent = { ok: false };
        if (client?.email) sent = await sendEmail({ to: client.email, subject, text, html });
        if (sent.ok) {
          db.prepare(`UPDATE orders SET balance_confirmation_email_sent_at = datetime('now') WHERE id = ?`).run(order.id);
        }
        logMessage(order.client_id, 'balance_paid', `${subject}\n\n${text}`);

        // Internal "you got paid" notification, symmetric with the deposit
        // one above — same reason: Luc wasn't being told when this happened.
        try {
          const balanceVars = {
            first_name: client?.first_name || '',
            last_name: client?.last_name || '',
            email: client?.email || '',
            product_label: productLabel(order.product_type),
            order_reference: order.order_number || order.id,
            balance_amount: formatMoney(order.balance_amount_cents, settings.currency),
            total_amount: vars.total_amount,
          };
          const internalSubject = renderTemplate(settings.balance_received_subject, balanceVars);
          const internalText = renderTemplate(settings.balance_received_body, balanceVars);
          if (settings.internal_notify_email) {
            await sendEmail({ to: settings.internal_notify_email, subject: internalSubject, text: internalText, html: wrapHtml(internalText) });
          }
        } catch (e) {
          console.error('[stripe-webhook] balance-received notification failed (non-fatal):', e.message);
        }
      }
    }

    // "The SLY Experience" gift purchase (2026-08-30) — the buyer just paid
    // in full for a pack; there's no order yet (no client, no config) and
    // nothing to book. What happens here is entirely about handing the buyer
    // a usable, redeemable card: activate it, generate the QR-carrying email.
    // The actual order only gets created later, at redemption time, by
    // POST /api/gift-cards/:code/redeem.
    if (kind === 'gift') {
      const card = db.prepare('SELECT * FROM gift_cards WHERE stripe_checkout_session_id = ?').get(session.id);
      if (!card) {
        console.error(`[stripe-webhook] gift checkout.session.completed for unknown session ${session.id} — no gift card was staged via /api/gift-cards/intake`);
      } else if (card.status === 'pending') {
        const expiresAt = new Date();
        expiresAt.setMonth(expiresAt.getMonth() + 12);
        db.prepare(`
          UPDATE gift_cards SET status = 'active', expires_at = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(expiresAt.toISOString(), card.id);
        logMessage(null, 'gift_purchased', `SLY Experience purchased (${card.pack_key}) — code ${card.code}`);

        try {
          const settings = getSettings();
          const url = redeemUrl(card.code);
          const qrDataUrl = await QRCode.toDataURL(url, { width: 320, margin: 1 });
          const vars = {
            beneficiary_name: card.beneficiary_name || 'votre invité(e)',
            pack_label: productLabel(card.pack_key),
            price_paid: formatMoney(card.price_paid_cents, settings.currency),
            expires_at: new Date(expiresAt).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' }),
            redeem_url: url,
          };
          const subject = renderTemplate(settings.gift_purchased_subject, vars);
          const text = renderTemplate(settings.gift_purchased_body, vars);
          const html = giftCardEmailHtml({ text, qrDataUrl, redeemUrl: url });
          if (card.buyer_email) {
            await sendEmail({ to: card.buyer_email, subject, text, html });
          }
        } catch (e) {
          console.error('[stripe-webhook] gift card email failed (non-fatal):', e.message);
        }

        try {
          const settings = getSettings();
          const vars = {
            buyer_first_name: card.buyer_first_name || '',
            buyer_last_name: card.buyer_last_name || '',
            buyer_email: card.buyer_email || '',
            pack_label: productLabel(card.pack_key),
            price_paid: formatMoney(card.price_paid_cents, settings.currency),
            beneficiary_name: card.beneficiary_name || '',
            code: card.code,
          };
          const subject = renderTemplate(settings.internal_gift_purchased_subject, vars);
          const text = renderTemplate(settings.internal_gift_purchased_body, vars);
          if (settings.internal_notify_email) {
            await sendEmail({ to: settings.internal_notify_email, subject, text, html: wrapHtml(text) });
          }
        } catch (e) {
          console.error('[stripe-webhook] gift-purchased internal notification failed (non-fatal):', e.message);
        }
      }
    }
  }

  // Always 200 for anything we've already handled or don't care about —
  // Stripe retries indefinitely on non-2xx, and "order not found" is a
  // manual-follow-up case, not something retrying will ever fix.
  res.json({ received: true });
});

// POST /api/webhooks/fathom/:token — "New meeting content ready" event.
// Two layers of verification: the random :token in the URL (settings.
// fathom_webhook_token, never exposed elsewhere) plus a real HMAC-SHA256
// signature check (settings.fathom_webhook_secret, Svix convention — see
// verifyFathomSignature in lib/fathom.js). Mounted with express.raw() in
// index.js (alongside /stripe) so req.body here is the raw Buffer the
// signature needs, not pre-parsed JSON.
router.post('/fathom/:token', async (req, res) => {
  const settings = getSettings();
  if (!settings.fathom_webhook_token || req.params.token !== settings.fathom_webhook_token) {
    return res.status(404).end(); // no hint to a guesser that this route exists
  }

  const rawBody = req.body;
  if (settings.fathom_webhook_secret) {
    const valid = verifyFathomSignature({ headers: req.headers, rawBody, secret: settings.fathom_webhook_secret });
    if (!valid) return res.status(400).json({ error: 'invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'invalid JSON' });
  }

  try {
    const fields = extractFathomFields(payload || {});
    const match = matchFathomCall({ emails: fields.emails, startedAt: fields.startedAt });
    storeFathomCall({ rawPayload: payload, fields, match });

    // Reuses the existing per-client Activity log (already visible in the
    // CRM's Client detail panel) instead of a new dedicated viewer — this is
    // the "compte rendu clair tout le temps" surface, no new UI needed.
    if (match.client) {
      const transcriptText = typeof fields.transcript === 'string' ? fields.transcript : '';
      const MAX_TRANSCRIPT_CHARS = 8000;
      const truncated = transcriptText.length > MAX_TRANSCRIPT_CHARS;
      const parts = [];
      if (fields.summary) parts.push(`RÉSUMÉ FATHOM\n${typeof fields.summary === 'string' ? fields.summary : JSON.stringify(fields.summary)}`);
      if (fields.actionItems) parts.push(`POINTS D'ACTION\n${Array.isArray(fields.actionItems) ? fields.actionItems.map((a) => `- ${a}`).join('\n') : JSON.stringify(fields.actionItems)}`);
      if (transcriptText) parts.push(`TRANSCRIPTION${truncated ? ' (tronquée)' : ''}\n${transcriptText.slice(0, MAX_TRANSCRIPT_CHARS)}`);
      if (parts.length) logMessage(match.client.id, 'call_transcript', parts.join('\n\n'));
    }

    if (settings.fathom_call_notify_email) {
      const vars = {
        client_name: match.client ? `${match.client.first_name || ''} ${match.client.last_name || ''}`.trim() : '',
        order_reference: match.order?.order_number || match.order?.id || '',
        meeting_title: fields.title || '',
        summary: typeof fields.summary === 'string' ? fields.summary : '',
        match_status: match.matchStatus,
      };
      const isMatched = match.matchStatus === 'matched';
      const subject = renderTemplate(
        isMatched ? settings.fathom_call_matched_subject : settings.fathom_call_unmatched_subject,
        vars,
      );
      const text = renderTemplate(
        isMatched ? settings.fathom_call_matched_body : settings.fathom_call_unmatched_body,
        vars,
      );
      await sendEmail({ to: settings.fathom_call_notify_email, subject, text, html: wrapHtml(text) });
    }

    res.json({ received: true, matchStatus: match.matchStatus });
  } catch (e) {
    // Non-fatal from Fathom's point of view — always ack so it doesn't retry
    // forever, but log loudly since a silent drop here loses a transcript.
    console.error('[webhooks/fathom] failed to process:', e.message);
    res.json({ received: true, error: 'processing_failed' });
  }
});

export default router;
