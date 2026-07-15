// Thin wrapper around the Resend HTTP API — no SDK dependency needed, Node 22 has global fetch.

export function isEmailConfigured() {
  return !!process.env.RESEND_API_KEY;
}

// { to, subject, text } -> { ok, id?, error? }
export async function sendEmail({ to, subject, text }) {
  if (!isEmailConfigured()) {
    return { ok: false, error: 'RESEND_API_KEY not configured' };
  }
  const from = process.env.EMAIL_FROM || 'SLY <onboarding@resend.dev>';

  const res = await fetch('https://api.resend.com/emails', {
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
