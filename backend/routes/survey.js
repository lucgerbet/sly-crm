// Public satisfaction survey, reached from the payment-confirmation email.
//
// Public by necessity: a client has no account and never will, so the
// unguessable per-order token in the URL is the whole access model. It
// authorises exactly one thing — answering this one survey — and exposes
// nothing but the client's own first name and order reference.
//
// Server-rendered rather than part of the CRM's React app: the app lives
// behind Basic Auth, and a client must never meet a login screen. Plain HTML
// also means the page works with no JavaScript, which is the right bar for
// something opened from a phone mail client.
import { Router } from 'express';
import db from '../db.js';
import { getSettings } from './settings.js';
import { PALETTE } from '../lib/emailTemplate.js';
import { logMessage } from '../lib/orderHelpers.js';

const router = Router();

const SERIF = "'Cormorant Garamond', Cormorant, 'Iowan Old Style', Georgia, serif";
const SANS = "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

const RATING_FIELDS = [
  ['rating_overall', 'survey_q_overall'],
  ['rating_guidance', 'survey_q_guidance'],
  ['rating_simplicity', 'survey_q_simplicity'],
  ['rating_recommend', 'survey_q_recommend'],
];

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
  .wrap { max-width:560px; margin:0 auto; padding:40px 18px 64px; }
  .mark { text-align:center; margin-bottom:26px; }
  .mark .n { font-family:${SERIF}; font-size:27px; letter-spacing:.30em; }
  .mark .s { font-size:9px; letter-spacing:.34em; text-transform:uppercase; color:${PALETTE.muted}; margin-top:5px; }
  .card { background:#fff; border:1px solid ${PALETTE.border}; padding:34px 30px; }
  h1 { font-family:${SERIF}; font-weight:400; font-size:26px; line-height:1.25; margin:0 0 8px; }
  .sub { color:${PALETTE.muted}; font-size:14px; margin:0 0 28px; }
  .q { margin:0 0 26px; }
  .q legend { font-size:15px; line-height:1.5; padding:0; margin:0 0 12px; }
  fieldset { border:0; padding:0; margin:0; }
  /* Radios styled as a scale. The input stays in the DOM (keyboard + no-JS
     support); the label is what's actually seen. */
  .scale { display:flex; gap:8px; }
  .scale input { position:absolute; opacity:0; width:0; height:0; }
  .scale label {
    flex:1; text-align:center; padding:12px 0; border:1px solid ${PALETTE.border};
    font-size:15px; cursor:pointer; background:#fff; border-radius:2px;
  }
  .scale input:checked + label { background:${PALETTE.cherry}; color:#fff; border-color:${PALETTE.cherry}; }
  .scale input:focus-visible + label { outline:2px solid ${PALETTE.choco}; outline-offset:2px; }
  .ends { display:flex; justify-content:space-between; font-size:11px; color:${PALETTE.muted}; margin-top:6px; }
  textarea {
    width:100%; box-sizing:border-box; border:1px solid ${PALETTE.border}; border-radius:2px;
    padding:12px; font-family:${SANS}; font-size:15px; min-height:110px; resize:vertical;
  }
  textarea:focus { outline:none; border-color:${PALETTE.cherry}; }
  button {
    background:${PALETTE.cherry}; color:#fff; border:0; border-radius:2px; cursor:pointer;
    padding:15px 34px; font-family:${SANS}; font-size:14px; font-weight:500;
    letter-spacing:.06em; text-transform:uppercase; margin-top:6px;
  }
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

function thanks(message) {
  return page({
    title: 'Merci — SLY Atelier',
    inner: `<h1>Merci.</h1><p class="sub" style="margin-bottom:0;">${esc(message)}</p>`,
  });
}

// GET /survey/:token — the form itself.
router.get('/:token', (req, res) => {
  const survey = db.prepare('SELECT * FROM satisfaction_surveys WHERE token = ?').get(req.params.token);
  // Same response for an unknown and a malformed token: nothing here should
  // help someone work out whether a token exists.
  if (!survey) return res.status(404).send(page({ title: 'SLY Atelier', inner: '<h1>Lien introuvable</h1><p class="sub">Ce lien n\'est plus valable.</p>' }));
  if (survey.submitted_at) {
    return res.send(thanks('Votre réponse a bien été enregistrée. Elle est lue, et elle compte.'));
  }

  const client = survey.client_id ? db.prepare('SELECT first_name FROM clients WHERE id = ?').get(survey.client_id) : null;
  const order = db.prepare('SELECT order_number FROM orders WHERE id = ?').get(survey.order_id);
  const s = getSettings();

  const questions = RATING_FIELDS.map(([field, key]) => `
    <fieldset class="q">
      <legend>${esc(s[key])}</legend>
      <div class="scale">
        ${[1, 2, 3, 4, 5].map((n) => `
          <input type="radio" id="${field}_${n}" name="${field}" value="${n}" required>
          <label for="${field}_${n}">${n}</label>`).join('')}
      </div>
      <div class="ends"><span>Pas du tout</span><span>Tout à fait</span></div>
    </fieldset>`).join('');

  res.send(page({
    title: 'Votre avis — SLY Atelier',
    inner: `
      <h1>${esc(s.survey_intro)}</h1>
      <p class="sub">
        ${client?.first_name ? esc(client.first_name) + ', deux' : 'Deux'} minutes, cinq questions.
        ${order?.order_number ? 'Commande ' + esc(order.order_number) + '.' : ''}
      </p>
      <form method="POST" action="/survey/${esc(survey.token)}">
        ${questions}
        <fieldset class="q">
          <legend>${esc(s.survey_q_improvement)}</legend>
          <textarea name="improvement" placeholder="Écrivez librement — même ce qui fâche."></textarea>
        </fieldset>
        <button type="submit">Envoyer</button>
      </form>`,
  }));
});

// POST /survey/:token — one submission per token.
router.post('/:token', (req, res) => {
  const survey = db.prepare('SELECT * FROM satisfaction_surveys WHERE token = ?').get(req.params.token);
  if (!survey) return res.status(404).send(page({ title: 'SLY Atelier', inner: '<h1>Lien introuvable</h1>' }));
  if (survey.submitted_at) return res.send(thanks('Votre réponse avait déjà été enregistrée.'));

  // Ratings are clamped rather than trusted: this endpoint is public, so the
  // body is attacker-controlled and anything outside 1–5 is stored as null.
  const rating = (v) => {
    const n = Number.parseInt(v, 10);
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
  };
  const body = req.body || {};
  const values = RATING_FIELDS.map(([field]) => rating(body[field]));
  const improvement = typeof body.improvement === 'string' ? body.improvement.trim().slice(0, 4000) : null;

  db.prepare(`
    UPDATE satisfaction_surveys
    SET rating_overall = ?, rating_guidance = ?, rating_simplicity = ?, rating_recommend = ?,
        improvement = ?, submitted_at = datetime('now')
    WHERE id = ?
  `).run(...values, improvement || null, survey.id);

  if (survey.client_id) {
    const lines = RATING_FIELDS.map(([field], i) => `${field.replace('rating_', '')} : ${values[i] ?? '—'}/5`);
    logMessage(survey.client_id, 'note',
      `ENQUÊTE DE SATISFACTION\n\n${lines.join('\n')}${improvement ? `\n\nÀ améliorer : ${improvement}` : ''}`);
  }

  res.send(thanks('Votre retour est enregistré. Il sera lu, et il servira.'));
});

export default router;
