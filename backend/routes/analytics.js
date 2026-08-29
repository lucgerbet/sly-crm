import { Router } from 'express';
import { randomUUID, createHash } from 'node:crypto';
import db from '../db.js';
import { requireIntakeSecret } from '../lib/orderHelpers.js';
import { getSettings } from './settings.js';

const router = Router();

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// sha256(salt + ip + user-agent + calendar day) — rotates every day, so no
// value here ever identifies the same real visitor across two different
// days. This is what lets pageview tracking run without a cookie-consent
// banner: nothing persists on the client, and the server can't link a
// visitor's activity across days even from its own database.
function visitorHash(req, salt) {
  const day = new Date().toISOString().slice(0, 10);
  const ip = clientIp(req);
  const ua = req.headers['user-agent'] || '';
  return createHash('sha256').update(`${salt}|${ip}|${ua}|${day}`).digest('hex');
}

function referrerDomain(referrer) {
  if (!referrer) return null;
  try {
    return new URL(referrer).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// POST /api/analytics/track — called server-to-server by sly-shop's own
// /api/track route (never directly by the browser, so the intake secret
// never reaches the client). Public at the Traefik level, real auth here.
router.post('/track', requireIntakeSecret, (req, res) => {
  const { path, referrer, utmSource, utmMedium, utmCampaign } = req.body || {};
  if (!path || typeof path !== 'string') {
    return res.status(400).json({ error: 'path is required' });
  }
  const settings = getSettings();
  const hash = visitorHash(req, settings.analytics_hash_salt || '');

  db.prepare(`
    INSERT INTO page_views (id, path, referrer_domain, utm_source, utm_medium, utm_campaign, visitor_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), path.slice(0, 500), referrerDomain(referrer), utmSource || null, utmMedium || null, utmCampaign || null, hash);

  res.status(201).json({ ok: true });
});

// GET /api/analytics/summary?days=30 — human-authenticated (behind Traefik
// Basic Auth, not in the public router allowlist). Traffic volume/sources +
// a conversion funnel. The funnel's bottom three steps reuse the existing
// messages/orders instrumentation (lead_capture, deposit_paid, balance_paid)
// rather than trying to stitch page_views into full visitor sessions —
// aggregate counts per period are enough to see where the drop-off is.
router.get('/summary', (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
  const since = `-${days} days`;

  const totalViews = db.prepare(`SELECT COUNT(*) AS n FROM page_views WHERE created_at >= datetime('now', ?)`).get(since).n;
  // NOT a count of people. visitor_hash rotates every calendar day (that's the
  // whole reason this works without a cookie banner), so one person visiting
  // on five days is five hashes. This is a count of visits — daily uniques,
  // added up. The number of distinct humans behind them is unknowable here by
  // design, and pretending otherwise is how a 44 gets read as 44 customers.
  const visits = db.prepare(`SELECT COUNT(DISTINCT visitor_hash) AS n FROM page_views WHERE created_at >= datetime('now', ?)`).get(since).n;
  // The busiest single day is the one honest floor on "how many people at
  // most were here at once" — within a day, one hash really is one device.
  const busiestDay = db.prepare(`
    SELECT COUNT(DISTINCT visitor_hash) AS n
    FROM page_views WHERE created_at >= datetime('now', ?)
    GROUP BY date(created_at) ORDER BY n DESC LIMIT 1
  `).get(since)?.n || 0;

  const viewsByDay = db.prepare(`
    SELECT date(created_at) AS day, COUNT(*) AS n
    FROM page_views WHERE created_at >= datetime('now', ?)
    GROUP BY day ORDER BY day ASC
  `).all(since);

  const topPages = db.prepare(`
    SELECT path, COUNT(*) AS n
    FROM page_views WHERE created_at >= datetime('now', ?)
    GROUP BY path ORDER BY n DESC LIMIT 10
  `).all(since);

  const topReferrers = db.prepare(`
    SELECT COALESCE(utm_source, referrer_domain, 'direct') AS source, COUNT(*) AS n
    FROM page_views WHERE created_at >= datetime('now', ?)
    GROUP BY source ORDER BY n DESC LIMIT 10
  `).all(since);

  const configuring = db.prepare(`
    SELECT COUNT(DISTINCT visitor_hash) AS n FROM page_views
    WHERE created_at >= datetime('now', ?) AND path LIKE '/customize%'
  `).get(since).n;

  // DISTINCT client_id, not COUNT(*): the activity log gets one row per event,
  // so a client who opens the configurator twice logs two lead_capture rows.
  // Counting rows made the funnel report more people than exist — which is the
  // one thing a funnel must never do.
  const countMessages = (type) => db.prepare(`
    SELECT COUNT(DISTINCT client_id) AS n FROM messages WHERE type = ? AND date >= datetime('now', ?)
  `).get(type, since).n;

  const funnel = [
    { key: 'visitors', label: 'Visites', n: visits },
    { key: 'configuring', label: 'Configurateur ouvert', n: configuring },
    { key: 'leads', label: 'Email laissé', n: countMessages('lead_capture') },
    { key: 'deposits', label: 'Acompte payé', n: countMessages('deposit_paid') },
    { key: 'balance', label: 'Solde payé', n: countMessages('balance_paid') },
  ];

  res.json({
    days,
    totalViews,
    visits,
    busiestDay,
    viewsByDay,
    topPages,
    topReferrers,
    funnel,
  });
});

export default router;
