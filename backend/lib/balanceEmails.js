// The three balance-payment emails: the recap sent at finalize, then two
// chases if it goes unpaid. One builder for all of them so the branding, the
// button placement and the amounts can't drift apart between them.
import { renderTemplate } from './email.js';
import { renderBrandedEmail } from './emailTemplate.js';
import { formatMoney, productLabel } from './orderHelpers.js';

// Each stage differs only in wording and urgency — the structure is identical.
export const BALANCE_EMAIL_STAGES = {
  recap: {
    subjectKey: 'order_recap_subject',
    introKey: 'order_recap_intro',
    outroKey: 'order_recap_outro',
    eyebrow: 'Récapitulatif de commande',
    ctaLabel: 'Régler le solde',
    // Only the recap shows the full configuration: by the time a chase goes
    // out the client has already had the detail, and repeating it pushes the
    // one thing that matters — the button — further out of sight.
    includeConfig: true,
  },
  reminder1: {
    subjectKey: 'balance_reminder_1_subject',
    introKey: 'balance_reminder_1_intro',
    outroKey: 'balance_reminder_1_outro',
    eyebrow: 'Solde en attente',
    ctaLabel: 'Régler le solde',
    includeConfig: false,
  },
  reminder2: {
    subjectKey: 'balance_reminder_2_subject',
    introKey: 'balance_reminder_2_intro',
    outroKey: 'balance_reminder_2_outro',
    eyebrow: 'Production en attente',
    ctaLabel: 'Régler le solde et lancer la production',
    includeConfig: false,
  },
};

// Sent the moment the balance clears. Same shell as the payment emails, but
// the button is the satisfaction survey — there is nothing left to pay, and
// this is the one moment the client is most willing to answer.
export function buildThankYouEmail({ order, client, settings, surveyUrl }) {
  const currency = settings.currency;
  const label = productLabel(order.product_type);
  const total = formatMoney((order.deposit_amount_cents || 0) + (order.balance_amount_cents || 0), currency);

  const vars = {
    first_name: client?.first_name || '',
    last_name: client?.last_name || '',
    product_label: label,
    order_reference: order.order_number || order.id,
    total_amount: total,
    signature: settings.email_signature || '',
  };

  const subject = renderTemplate(settings.balance_payment_confirmation_subject, vars);
  const intro = renderTemplate(settings.balance_payment_confirmation_intro, vars);
  const outro = renderTemplate(settings.balance_payment_confirmation_outro, vars);
  const signature = renderTemplate(settings.email_signature || '', vars);

  const detailRows = [
    ['Commande', vars.order_reference],
    ['Pièce', label],
    ['Total réglé', total],
  ];

  const html = renderBrandedEmail({
    preheader: `${label} — règlement reçu, production lancée`,
    eyebrow: 'Règlement reçu',
    title: `Merci, ${vars.first_name}`.trim().replace(/,$/, ''),
    intro,
    // Survey rather than payment. If it's somehow missing the shell simply
    // renders no button instead of a dead link.
    ctaUrl: surveyUrl || undefined,
    ctaLabel: 'Donner mon avis — 2 minutes',
    ctaNote: surveyUrl ? 'Cinq questions, anonymes pour personne mais lues par moi seul.' : undefined,
    body: outro,
    detailRows,
    signature,
    footerNote: 'Cet email confirme le règlement de votre commande.',
  });

  const text = [
    intro,
    '',
    ...(surveyUrl ? [`Donner mon avis (2 minutes) : ${surveyUrl}`, ''] : []),
    outro,
    '',
    ...detailRows.map(([k, v]) => `${k} : ${v}`),
    '',
    signature,
  ].join('\n');

  return { subject, html, text };
}

export function buildBalanceEmail({ stage, order, client, settings }) {
  const cfg = BALANCE_EMAIL_STAGES[stage];
  if (!cfg) throw new Error(`Unknown balance email stage: ${stage}`);

  const currency = settings.currency;
  const label = productLabel(order.product_type);
  const balance = formatMoney(order.balance_amount_cents, currency);
  const deposit = formatMoney(order.deposit_amount_cents, currency);
  const total = formatMoney((order.deposit_amount_cents || 0) + (order.balance_amount_cents || 0), currency);

  const vars = {
    first_name: client.first_name || '',
    last_name: client.last_name || '',
    product_label: label,
    order_reference: order.order_number || order.id,
    deposit_amount: deposit,
    balance_amount: balance,
    total_amount: total,
    payment_link_url: order.stripe_payment_link_url || '',
    signature: settings.email_signature || '',
  };

  const subject = renderTemplate(settings[cfg.subjectKey], vars);
  const intro = renderTemplate(settings[cfg.introKey], vars);
  const outro = renderTemplate(settings[cfg.outroKey], vars);
  const signature = renderTemplate(settings.email_signature || '', vars);

  const amountRows = [
    ['Commande', vars.order_reference],
    ['Pièce', label],
    ['Acompte réglé', deposit],
    ['Solde à régler', balance],
    ['Total', total],
  ];

  let configRows = [];
  if (cfg.includeConfig) {
    try {
      const parsed = JSON.parse(order.config_summary || '[]');
      if (Array.isArray(parsed)) {
        configRows = parsed
          .filter((r) => Array.isArray(r) && r.length >= 2)
          .map(([k, v]) => [String(k), String(v)]);
      }
    } catch { configRows = []; }
  }

  const html = renderBrandedEmail({
    preheader: `${label} — solde de ${balance} à régler`,
    eyebrow: cfg.eyebrow,
    title: subject.replace(/ — .*$/, ''),
    intro,
    ctaUrl: vars.payment_link_url,
    ctaLabel: cfg.ctaLabel,
    ctaNote: `Solde à régler : ${balance} · Paiement sécurisé par Stripe`,
    body: outro,
    detailRows: [...amountRows, ...configRows],
    signature,
    footerNote: 'Cet email concerne votre commande en cours et vous est adressé à ce titre.',
  });

  // Plain-text fallback, same running order as the HTML so the link is still
  // near the top for anyone reading text-only.
  const text = [
    intro,
    '',
    `Régler le solde : ${vars.payment_link_url}`,
    '',
    outro,
    '',
    ...amountRows.map(([k, v]) => `${k} : ${v}`),
    ...(configRows.length ? ['', ...configRows.map(([k, v]) => `${k} : ${v}`)] : []),
    '',
    signature,
  ].join('\n');

  return { subject, html, text };
}
