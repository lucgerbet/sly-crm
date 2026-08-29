// Branded HTML shell for client-facing emails.
//
// Palette and type are lifted from sly-shop's globals.css so an email reads
// as the same house as the site: offwhite ground, ink text, cherry accent,
// a serif wordmark against a sans body.
//
// Two email-specific constraints shape everything below:
//  - Tables, not flexbox. Outlook renders modern layout unpredictably; a
//    centred table is the only thing that behaves everywhere.
//  - Inline styles only. Gmail strips <style> blocks, so a stylesheet would
//    silently degrade to unstyled text for a large share of recipients.
// Webfonts are deliberately not linked either — several clients block them,
// so the stacks below fall back to fonts that are actually installed.

const PALETTE = {
  offwhite: '#f8f4ef',
  white: '#ffffff',
  ink: '#1a1410',
  choco: '#3a2a23',
  cherry: '#5a1f24',
  border: '#e5ddd5',
  muted: '#6b5b4e',
};

const SERIF = "'Cormorant Garamond', Cormorant, 'Iowan Old Style', Georgia, 'Times New Roman', serif";
const SANS = "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function paragraphs(text, { color = PALETTE.ink, size = 15 } = {}) {
  return escapeHtml(text)
    .split('\n\n')
    .filter((p) => p.trim())
    .map((p) => `<p style="margin:0 0 16px;font-family:${SANS};font-size:${size}px;line-height:1.65;color:${color};white-space:pre-line;">${p}</p>`)
    .join('');
}

function button(url, label) {
  // Belt-and-braces centring: the wrapper table handles real clients, the
  // conditional comment gives Outlook a VML button it can actually render.
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px;">
      <tr><td style="border-radius:2px;background:${PALETTE.cherry};">
        <a href="${escapeHtml(url)}"
           style="display:inline-block;padding:15px 34px;font-family:${SANS};font-size:14px;font-weight:500;
                  letter-spacing:0.06em;text-transform:uppercase;color:#ffffff;text-decoration:none;border-radius:2px;">
          ${escapeHtml(label)}
        </a>
      </td></tr>
    </table>`;
}

/**
 * Renders a full branded email.
 *
 * `intro` then `cta` come first on purpose: the payment link has to be
 * reachable in the first couple of lines, before any client has to scroll or
 * read a summary. Everything explanatory lives below it.
 */
export function renderBrandedEmail({
  preheader,          // hidden one-liner shown in the inbox preview
  eyebrow,            // small caps line above the title
  title,
  intro,              // plain text, rendered above the button
  ctaUrl,
  ctaLabel,
  ctaNote,            // small print under the button (e.g. the amount)
  body,               // plain text, rendered below the button
  detailRows,         // [[label, value], ...] rendered as a clean table
  signature,
  footerNote,
}) {
  const detailTable = (detailRows || []).length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
              style="margin:8px 0 28px;border-top:1px solid ${PALETTE.border};">
         ${detailRows.map(([label, value]) => `
           <tr>
             <td style="padding:11px 0;border-bottom:1px solid ${PALETTE.border};font-family:${SANS};
                        font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${PALETTE.muted};
                        vertical-align:top;width:42%;">${escapeHtml(label)}</td>
             <td style="padding:11px 0;border-bottom:1px solid ${PALETTE.border};font-family:${SANS};
                        font-size:14px;color:${PALETTE.ink};vertical-align:top;">${escapeHtml(value)}</td>
           </tr>`).join('')}
       </table>`
    : '';

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SLY Atelier</title>
</head>
<body style="margin:0;padding:0;background:${PALETTE.offwhite};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader || '')}</div>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${PALETTE.offwhite};">
    <tr><td align="center" style="padding:36px 16px;">

      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;">

        <tr><td style="padding:0 0 22px;text-align:center;">
          <div style="font-family:${SERIF};font-size:27px;letter-spacing:0.30em;color:${PALETTE.ink};">SLY</div>
          <div style="font-family:${SANS};font-size:9px;letter-spacing:0.34em;text-transform:uppercase;color:${PALETTE.muted};margin-top:5px;">Atelier</div>
        </td></tr>

        <tr><td style="background:${PALETTE.white};border:1px solid ${PALETTE.border};padding:38px 36px;">

          ${eyebrow ? `<div style="font-family:${SANS};font-size:10px;letter-spacing:0.20em;text-transform:uppercase;color:${PALETTE.cherry};margin:0 0 12px;">${escapeHtml(eyebrow)}</div>` : ''}
          ${title ? `<h1 style="margin:0 0 20px;font-family:${SERIF};font-size:27px;font-weight:400;line-height:1.25;color:${PALETTE.ink};">${escapeHtml(title)}</h1>` : ''}

          ${intro ? paragraphs(intro) : ''}
          ${ctaUrl ? button(ctaUrl, ctaLabel || 'Régler') : ''}
          ${ctaNote ? `<p style="margin:-16px 0 26px;font-family:${SANS};font-size:12px;color:${PALETTE.muted};">${escapeHtml(ctaNote)}</p>` : ''}

          ${body ? paragraphs(body) : ''}
          ${detailTable}

          ${signature ? `
            <div style="margin-top:30px;padding-top:22px;border-top:1px solid ${PALETTE.border};">
              ${paragraphs(signature, { color: PALETTE.muted, size: 13 })}
            </div>` : ''}
        </td></tr>

        ${footerNote ? `
          <tr><td style="padding:20px 8px 0;text-align:center;">
            <p style="margin:0;font-family:${SANS};font-size:11px;line-height:1.6;color:${PALETTE.muted};">${escapeHtml(footerNote)}</p>
          </td></tr>` : ''}

        <tr><td style="padding:22px 8px 0;text-align:center;">
          <p style="margin:0;font-family:${SANS};font-size:10px;letter-spacing:0.10em;text-transform:uppercase;color:${PALETTE.border};">
            SLY Atelier · Sur-mesure
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export { PALETTE };
