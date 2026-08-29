// Thin wrapper around the Resend HTTP API — no SDK dependency needed, Node 22 has global fetch.

export function isEmailConfigured() {
  return !!process.env.RESEND_API_KEY;
}

// { to, subject, text, html?, attachments?, cc? } -> { ok, id?, error? }
// `html`/`attachments`/`cc` are optional — existing callers passing none of
// them are unaffected. `attachments`: [{ filename, content: Buffer }]. `cc`:
// string or string[] — e.g. so Luc gets his own copy of a client-facing
// email (order recap) without a second near-duplicate send.
export async function sendEmail({ to, subject, text, html, attachments, cc }) {
  if (!isEmailConfigured()) {
    return { ok: false, error: 'RESEND_API_KEY not configured' };
  }
  const from = process.env.EMAIL_FROM || 'SLY <onboarding@resend.dev>';

  // Overridable so tests can point at a local recorder and assert which
  // emails actually fire — otherwise every send is invisible and rules like
  // "only alert when the client really needs a tape" can't be proven.
  // Unset in every real environment, which keeps the default in force.
  const endpoint = process.env.RESEND_API_URL || 'https://api.resend.com/emails';

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text,
      ...(html ? { html } : {}),
      ...(cc ? { cc: Array.isArray(cc) ? cc : [cc] } : {}),
      ...(attachments?.length ? {
        attachments: attachments.map((a) => ({
          filename: a.filename,
          content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content,
        })),
      } : {}),
    }),
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    return { ok: false, error: body?.message || `Resend error ${res.status}` };
  }
  return { ok: true, id: body?.id };
}

// Replace {{key}} placeholders — unknown keys are left blank rather than left literal,
// so a typo in a template doesn't leak "{{typo}}" into a client's inbox.
export function renderTemplate(str, vars) {
  return (str || '').replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? ''));
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Wraps a rendered plain-text body in a minimal HTML shell, with an optional
// CTA button (used for the order recap's payment link). Templates themselves
// stay plain text in `settings` — simplest to edit from a future textarea UI
// without risking broken markup — this is the only place HTML gets generated.
export function wrapHtml(bodyText, { ctaUrl, ctaLabel } = {}) {
  const paragraphs = escapeHtml(bodyText)
    .split('\n\n')
    .filter(p => p.trim())
    .map(p => `<p style="margin:0 0 16px;white-space:pre-line;">${p}</p>`)
    .join('');
  const cta = ctaUrl
    ? `<p style="margin:24px 0;"><a href="${ctaUrl}" style="background:#1A1A1A;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:500;">${escapeHtml(ctaLabel || 'View')}</a></p>`
    : '';
  return `<div style="font-family:sans-serif;max-width:560px;color:#1A1A1A;line-height:1.5;">${paragraphs}${cta}</div>`;
}
