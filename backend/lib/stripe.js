import Stripe from 'stripe';

let _stripe = null;

export function isStripeConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

function stripeClient() {
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

// Verifies the Stripe-Signature header against the RAW request body.
// Throws if verification fails — callers should catch and respond 400.
export function verifyWebhookSignature(rawBody, signatureHeader) {
  return stripeClient().webhooks.constructEvent(
    rawBody,
    signatureHeader,
    process.env.STRIPE_WEBHOOK_SECRET
  );
}

// Creates a single-line-item Payment Link for an order balance. `metadata`
// propagates onto the resulting Checkout Session, which is how the webhook
// handler (routes/webhooks.js) tells a balance payment apart from a deposit.
export async function createBalancePaymentLink({ orderId, amountCents, label }) {
  const link = await stripeClient().paymentLinks.create({
    line_items: [{
      price_data: {
        currency: 'eur',
        product_data: { name: `Balance — ${label}` },
        unit_amount: amountCents,
      },
      quantity: 1,
    }],
    metadata: { kind: 'balance', orderId },
  });
  return { id: link.id, url: link.url };
}
