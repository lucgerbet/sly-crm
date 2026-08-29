import { Router } from 'express';
import { requireIntakeSecret, findOrCreateClient, logMessage } from '../lib/orderHelpers.js';

const router = Router();

// POST /api/leads/capture — called by sly-shop as soon as a visitor gives a
// valid email while configuring, well before they reach payment (unlike
// /api/orders/intake, which requires a real Stripe checkout session and only
// fires once the client is already at the deposit step). This is what makes
// an abandoned configuration visible to Luc at all: without it, a visitor
// who fills in 15 of 19 steps then closes the tab leaves no trace anywhere.
//
// Since 30/08/2026 it also serves surfaces that aren't the configurator —
// the /carte digital business cards being the first. Those send `source`
// (and often `phone`), which is why neither is hardcoded any more. Callers
// that send no `source` still land as 'sly-shop-lead', so the configurator's
// behaviour is unchanged.
router.post('/capture', requireIntakeSecret, (req, res) => {
  const { name, firstName, lastName, email, phone, source, productType, configSummary } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email is required' });

  const leadSource = (typeof source === 'string' && source.trim()) || 'sly-shop-lead';

  const client = findOrCreateClient({ firstName, lastName, name, email, phone, source: leadSource });

  const summaryText = Array.isArray(configSummary)
    ? configSummary.map(([label, value]) => `${label}: ${value}`).join('\n')
    : '';

  // The configurator wording would be a plain lie on any other surface —
  // nobody who scanned a business card "started a configuration".
  const headline = leadSource === 'sly-shop-lead'
    ? `Configuration démarrée sur le site (${productType || 'pièce non précisée'}) — pas encore d'acompte payé.`
    : `Coordonnées laissées via ${leadSource}.`;

  logMessage(
    client.id,
    'lead_capture',
    `${headline}${summaryText ? `\n\n${summaryText}` : ''}`
  );

  res.status(201).json({ clientId: client.id });
});

export default router;
