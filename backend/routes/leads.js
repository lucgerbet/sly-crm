import { Router } from 'express';
import { requireIntakeSecret, findOrCreateClient, logMessage } from '../lib/orderHelpers.js';

const router = Router();

// POST /api/leads/capture — called by sly-shop as soon as a visitor gives a
// valid email while configuring, well before they reach payment (unlike
// /api/orders/intake, which requires a real Stripe checkout session and only
// fires once the client is already at the deposit step). This is what makes
// an abandoned configuration visible to Luc at all: without it, a visitor
// who fills in 15 of 19 steps then closes the tab leaves no trace anywhere.
router.post('/capture', requireIntakeSecret, (req, res) => {
  const { name, firstName, lastName, email, productType, configSummary } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email is required' });

  const client = findOrCreateClient({ firstName, lastName, name, email, source: 'sly-shop-lead' });

  const summaryText = Array.isArray(configSummary)
    ? configSummary.map(([label, value]) => `${label}: ${value}`).join('\n')
    : '';
  logMessage(
    client.id,
    'lead_capture',
    `Configuration démarrée sur le site (${productType || 'pièce non précisée'}) — pas encore d'acompte payé.${summaryText ? `\n\n${summaryText}` : ''}`
  );

  res.status(201).json({ clientId: client.id });
});

export default router;
