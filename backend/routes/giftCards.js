// "The SLY Experience" gift offer (2026-08-30). The buyer pays the full pack
// price up front and never books; a unique `code` — delivered as a QR code
// on the emailed gift card — is what lets the beneficiary, someone else,
// often weeks later, walk into the exact same configurator → booking flow as
// any paying customer, except the payment step is replaced with "already
// settled" (see sly-shop's StepPayment gift-mode).
import { Router } from 'express';
import { randomUUID, randomBytes } from 'node:crypto';
import db from '../db.js';
import { sendEmail, renderTemplate, wrapHtml } from '../lib/email.js';
import { getSettings } from './settings.js';
import {
  requireIntakeSecret, findOrCreateClient, formatMoney, nextOrderNumber, logMessage, productLabel,
} from '../lib/orderHelpers.js';

const router = Router();

// Excludes visually ambiguous characters (0/O, 1/I/L) since this may need to
// be typed by hand if a QR scan fails. 8 chars from a 32-letter alphabet is
// ~1.6e11 possibilities — plenty for a low-volume gift line, collision check
// below is just cheap insurance.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateGiftCode() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const bytes = randomBytes(8);
    let code = '';
    for (let i = 0; i < 8; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (!db.prepare('SELECT 1 FROM gift_cards WHERE code = ?').get(code)) return code;
  }
  throw new Error('Could not generate a unique gift code after 10 attempts');
}

function packRow(packKey) {
  return db.prepare('SELECT * FROM products WHERE key = ? AND is_pack = 1').get(packKey);
}

function redeemUrl(code) {
  const base = process.env.PUBLIC_SHOP_URL || 'https://www.sly-atelier.com';
  return `${base.replace(/\/$/, '')}/experience/carte/${code}`;
}

// POST /api/gift-cards/intake — called by sly-shop right after it creates
// the Stripe Checkout session for a gift purchase, same "stage before the
// customer pays" pattern as POST /api/orders/intake. Generates the
// redemption code now so the QR-embedding email can be built the instant the
// webhook below confirms payment, with nothing left to compute at send time.
router.post('/intake', requireIntakeSecret, (req, res) => {
  const { stripeCheckoutSessionId, packKey, priceCents, buyer, beneficiaryName, giftMessage, mailingAddress } = req.body || {};
  if (!stripeCheckoutSessionId || !packKey || !buyer?.email) {
    return res.status(400).json({ error: 'stripeCheckoutSessionId, packKey and buyer.email are required' });
  }
  if (!packRow(packKey)) {
    return res.status(400).json({ error: `Unknown pack key: ${packKey}` });
  }

  const existing = db.prepare('SELECT * FROM gift_cards WHERE stripe_checkout_session_id = ?').get(stripeCheckoutSessionId);
  if (existing) return res.status(201).json({ giftCardId: existing.id, code: existing.code });

  const id = randomUUID();
  const code = generateGiftCode();
  db.prepare(`
    INSERT INTO gift_cards (
      id, code, pack_key, price_paid_cents, stripe_checkout_session_id,
      buyer_first_name, buyer_last_name, buyer_email,
      beneficiary_name, gift_message,
      mailing_address, mailing_city, mailing_zip
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, code, packKey, priceCents ?? null, stripeCheckoutSessionId,
    buyer.firstName || '', buyer.lastName || '', buyer.email,
    beneficiaryName || '', giftMessage || '',
    mailingAddress?.address || null, mailingAddress?.city || null, mailingAddress?.zip || null,
  );

  res.status(201).json({ giftCardId: id, code });
});

// GET /api/gift-cards/:code — validity check, read by sly-shop's redemption
// page and by the configurator itself (gift-mode) before it lets someone
// skip payment. Secret-gated like the rest of this API: sly-shop proxies it
// server-to-server (see src/app/api/gift-cards/[code]/route.ts) rather than
// the browser calling here directly, same pattern as appointment-booked.
router.get('/:code', requireIntakeSecret, (req, res) => {
  const card = db.prepare('SELECT * FROM gift_cards WHERE code = ?').get((req.params.code || '').toUpperCase());
  if (!card) return res.json({ valid: false, reason: 'not_found' });
  if (card.status === 'redeemed') return res.json({ valid: false, reason: 'redeemed' });
  if (card.status === 'pending') return res.json({ valid: false, reason: 'not_found' }); // payment never completed
  if (card.expires_at && new Date(card.expires_at) < new Date()) return res.json({ valid: false, reason: 'expired' });

  const pack = packRow(card.pack_key);
  res.json({
    valid: true,
    packKey: card.pack_key,
    packLabel: pack?.label || card.pack_key,
    priceCents: card.price_paid_cents,
    beneficiaryName: card.beneficiary_name || '',
    giftMessage: card.gift_message || '',
    buyerFirstName: card.buyer_first_name || '',
    expiresAt: card.expires_at,
  });
});

// POST /api/gift-cards/:code/redeem — the beneficiary has just finished the
// classic pre-selection (same configurator any paying customer goes
// through) and is ready to book. Unlike a normal order, there is no Stripe
// session to wait on: this call itself both creates the paid order AND
// marks the gift card used, in one step, mirroring what the deposit webhook
// (routes/webhooks.js) does for a real payment — client find-or-create,
// shipping/tape-measure capture, internal notification — because from the
// CRM's point of view this order IS already paid, just not through Stripe.
router.post('/:code/redeem', requireIntakeSecret, (req, res) => {
  const code = (req.params.code || '').toUpperCase();
  const { customer, config, configSummary } = req.body || {};
  if (!customer?.email) return res.status(400).json({ error: 'customer.email is required' });

  const card = db.prepare('SELECT * FROM gift_cards WHERE code = ?').get(code);
  if (!card) return res.status(404).json({ error: 'not_found' });
  if (card.status === 'redeemed') return res.status(409).json({ error: 'already_redeemed', orderId: card.redeemed_order_id });
  if (card.status === 'pending') return res.status(409).json({ error: 'not_found' });
  if (card.expires_at && new Date(card.expires_at) < new Date()) return res.status(409).json({ error: 'expired' });

  const client = findOrCreateClient({
    firstName: customer.firstName, lastName: customer.lastName,
    email: customer.email, source: 'sly-experience-gift',
  });

  const orderId = randomUUID();
  const orderNumber = nextOrderNumber();
  db.prepare(`
    INSERT INTO orders (
      id, client_id, product_type, deposit_amount_cents, deposit_status, deposit_paid_at,
      status, config_json, config_summary, shop_config_summary, shop_config_json,
      order_number, gift_card_id
    ) VALUES (?, ?, ?, ?, 'paid', datetime('now'), 'deposit_paid', ?, ?, ?, ?, ?, ?)
  `).run(
    orderId, client.id, card.pack_key, card.price_paid_cents,
    JSON.stringify(config || {}), JSON.stringify(configSummary || []),
    JSON.stringify(configSummary || []), JSON.stringify(config || {}),
    orderNumber, card.id,
  );
  logMessage(client.id, 'order_intake', `SLY Experience redeemed (${card.pack_key}) — ${orderNumber} — code ${code}`);

  db.prepare(`
    UPDATE gift_cards SET status = 'redeemed', redeemed_at = datetime('now'), redeemed_order_id = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(orderId, card.id);

  // Same shipping/tape-measure lift as POST /api/orders/intake — a gift
  // redemption asks the exact same configurator questions as a paying order.
  if (config && typeof config === 'object') {
    const needsTape = config.hasTapeMeasure === 'no' ? 1 : 0;
    const shipping = [config.shippingAddress, config.shippingZip, config.shippingCity]
      .filter(Boolean).join(', ');
    const sets = ['needs_tape_measure = ?'];
    const vals = [needsTape];
    if (needsTape && shipping && !client.address) {
      sets.push('address = ?');
      vals.push(shipping);
    }
    db.prepare(`UPDATE clients SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .run(...vals, client.id);
  }

  // Internal notification — symmetric with the deposit/balance ones in
  // webhooks.js. No tape-measure alert branch here on purpose: it already
  // fires from this same shipping/tape-measure block's twin in
  // routes/orders.js /intake being skipped for gift orders would mean the
  // alert never fires for them; keeping it simple for v1, revisit if gift
  // orders turn out to need their own tape shipped often.
  try {
    const settings = getSettings();
    const vars = {
      first_name: client.first_name || '',
      last_name: client.last_name || '',
      email: client.email || '',
      pack_label: productLabel(card.pack_key),
      order_reference: orderNumber,
    };
    const subject = renderTemplate(settings.internal_gift_redeemed_subject, vars);
    const text = renderTemplate(settings.internal_gift_redeemed_body, vars);
    if (settings.internal_notify_email) {
      sendEmail({ to: settings.internal_notify_email, subject, text, html: wrapHtml(text) }).catch(() => {});
    }
  } catch (e) {
    console.error('[gift-cards] redeemed notification failed (non-fatal):', e.message);
  }

  res.status(201).json({ orderId, clientId: client.id, status: 'deposit_paid' });
});

export { generateGiftCode, redeemUrl };
export default router;
