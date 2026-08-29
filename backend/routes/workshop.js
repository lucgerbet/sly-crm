// Public workshop docket page, reached from the order email.
//
// The docket is NOT attached to that email any more: it lives behind the
// button here, and fetching it is what stamps `workshop_ack_at`. That single
// timestamp is the whole point — it turns "the workshop has the order
// somewhere" into a measurable "they opened it at 09:12 on the 3rd", which is
// the number Luc wants. An attachment would be opened without ever telling us.
//
// Public by necessity, exactly like the client survey: the workshop has no
// account and never will, so the unguessable per-order token in the URL is the
// whole access model. It authorises reading one docket — which the workshop is
// meant to have — and nothing else. No client name, address, price or contact
// details appear on this page; the docket itself carries only what the
// workshop needs to cut and sew.
//
// Bilingual FR/中文, server-rendered, no JavaScript: it will be opened on a
// phone, from an email, on a network that may not love a React bundle.
import { Router } from 'express';
import db from '../db.js';
import { logMessage } from '../lib/orderHelpers.js';
import { buildProductionOrderPdf } from '../lib/pdf.js';

const router = Router();

const PALETTE = {
  offwhite: '#f8f4ef', ink: '#1a1410', cherry: '#5a1f24',
  border: '#e5ddd5', muted: '#6b5b4e', green: '#1D9E75',
};
const SERIF = "'Cormorant Garamond', Cormorant, 'Iowan Old Style', Georgia, serif";
const SANS = "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page({ title, inner }) {
  return `<!DOCTYPE html>
<html lang="fr"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { margin:0; background:${PALETTE.offwhite}; font-family:${SANS}; color:${PALETTE.ink}; }
  .wrap { max-width:520px; margin:0 auto; padding:40px 18px 64px; }
  .mark { text-align:center; margin-bottom:26px; }
  .mark .n { font-family:${SERIF}; font-size:27px; letter-spacing:.30em; }
  .mark .s { font-size:9px; letter-spacing:.34em; text-transform:uppercase; color:${PALETTE.muted}; margin-top:5px; }
  .card { background:#fff; border:1px solid ${PALETTE.border}; padding:32px 28px; }
  h1 { font-family:${SERIF}; font-weight:400; font-size:25px; line-height:1.25; margin:0 0 6px; }
  .cn { font-size:15px; color:${PALETTE.muted}; margin:0 0 24px; }
  .ref { font-size:13px; color:${PALETTE.muted}; letter-spacing:.06em; margin:0 0 26px; }
  a.btn {
    display:block; box-sizing:border-box; background:${PALETTE.cherry}; color:#fff;
    border-radius:2px; padding:18px 20px; text-decoration:none; text-align:center;
    font-size:16px; line-height:1.5;
  }
  a.btn .c { display:block; font-size:14px; opacity:.85; margin-top:3px; }
  .note { color:${PALETTE.muted}; font-size:13px; line-height:1.6; margin:18px 0 0; }
  .seen { border:1px solid ${PALETTE.border}; border-left:3px solid ${PALETTE.green};
          padding:12px 15px; margin:0 0 18px; font-size:13px; line-height:1.55; color:${PALETTE.muted}; }
  .foot { text-align:center; margin-top:22px; font-size:10px; letter-spacing:.10em;
          text-transform:uppercase; color:${PALETTE.border}; }
</style>
</head><body>
  <div class="wrap">
    <div class="mark"><div class="n">SLY</div><div class="s">Atelier</div></div>
    <div class="card">${inner}</div>
    <div class="foot">SLY Atelier · Sur-mesure</div>
  </div>
</body></html>`;
}

function notFound(res) {
  // Same response for unknown and malformed: nothing here should help anyone
  // work out whether a token exists.
  return res.status(404).send(page({
    title: 'SLY Atelier',
    inner: '<h1>Link not found</h1><p class="cn">链接无效</p>',
  }));
}

function fmt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' });
}

// GET /workshop/:token — fallback landing page. The docket email links
// straight to the PDF below, so this is only reached by someone who trimmed
// the URL. English and Chinese: the workshop is in China, and a French page
// would be no help to them.
router.get('/:token', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE workshop_token = ?').get(req.params.token);
  if (!order) return notFound(res);

  res.send(page({
    title: `${order.order_number || 'Commande'} — SLY Atelier`,
    inner: `
      <h1>Production order</h1>
      <p class="cn">生产订单</p>
      <p class="ref">${esc(order.order_number || '')}</p>
      ${order.workshop_ack_at ? `
        <div class="seen">Opened ${esc(fmt(order.workshop_ack_at))} · 已于此时打开</div>` : ''}
      <a class="btn" href="/workshop/${esc(order.workshop_token)}/bon-de-commande.pdf">
        Open the production order
        <span class="c">打开生产订单</span>
      </a>
      <p class="note">
        The document opens as a PDF — download or print it.<br>
        文件为 PDF 格式，可下载或打印。
      </p>
    `,
  }));
});

// GET /workshop/:token/bon-de-commande.pdf — the docket, and the moment we
// call the order "taken in hand". Rebuilt from the order rather than served
// from a stored file, so the workshop always sees the current configuration.
router.get('/:token/bon-de-commande.pdf', async (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE workshop_token = ?').get(req.params.token);
    if (!order) return notFound(res);

    // Stamped once, never rewritten: a second read must not restart a clock
    // that has already been measured.
    //
    // Best-effort guard against a mail scanner or link previewer opening the
    // PDF before a human does — the email links straight here, so that fetch
    // is now possible, and a stamp fired by a robot would report a turnaround
    // the workshop never had. User-Agent sniffing is not proof of anything, so
    // the document is always served either way: only the measurement is
    // withheld. Under-measuring is recoverable; a wrong number is not.
    const ua = (req.get('user-agent') || '').toLowerCase();
    const looksAutomated = !ua
      || /bot|crawl|spider|preview|scan|fetch|monitor|curl|wget|python-requests|okhttp|headless/.test(ua);

    if (!order.workshop_ack_at && !looksAutomated) {
      const now = new Date().toISOString();
      db.prepare(`UPDATE orders SET workshop_ack_at = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(now, order.id);
      logMessage(order.client_id, 'workshop_update',
        `Atelier — bon de commande ouvert (${order.order_number || order.id})`);
    }

    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(order.client_id);
    const pdf = await buildProductionOrderPdf({
      order,
      client,
      config: JSON.parse(order.config_json || '{}'),
      shopConfigSummary: JSON.parse(order.shop_config_summary || '[]'),
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="bon-de-commande-${order.order_number || order.id}.pdf"`);
    // The stamp must reflect a human opening it, so no cache or proxy may
    // serve this without the request reaching us.
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  } catch (e) {
    console.error('[workshop] docket failed:', e.message);
    res.status(500).send(page({ title: 'SLY Atelier', inner: '<h1>Error</h1><p class="cn">出错了</p>' }));
  }
});

export default router;
