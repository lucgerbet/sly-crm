import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import db from '../db.js';

// Fathom signs webhooks using the Svix convention: webhook-id,
// webhook-timestamp and webhook-signature headers, HMAC-SHA256 over
// "id.timestamp.rawBody" using the base64-decoded secret (after the
// "whsec_" prefix), base64-encoded. webhook-signature can list several
// space-separated "v1,<sig>" candidates — any match is accepted.
export function verifyFathomSignature({ headers, rawBody, secret }) {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatureHeader = headers['webhook-signature'];
  if (!id || !timestamp || !signatureHeader || !secret) return false;

  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const expected = createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  const expectedBuf = Buffer.from(expected);

  return signatureHeader.split(' ').some((entry) => {
    const candidate = entry.split(',')[1];
    if (!candidate) return false;
    const candidateBuf = Buffer.from(candidate);
    if (candidateBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(candidateBuf, expectedBuf);
  });
}

// Fathom's public API webhook payload shape wasn't fully documented at
// integration time (developers.fathom.ai's docs index didn't expose the
// exact field paths for the "New meeting content ready" event, only that
// transcript/summary/action_items/crm_matches can be requested). This pulls
// each field from whichever of a few plausible locations it shows up in,
// and the route always keeps the full raw payload — so once the first real
// webhook arrives, the actual shape can be read straight from
// call_transcripts.raw_payload and this list of paths tightened if needed.
function pick(obj, paths) {
  for (const path of paths) {
    const value = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

export function extractFathomFields(payload) {
  const recordingId = pick(payload, ['recording_id', 'id', 'meeting.id', 'recording.id']);
  const title = pick(payload, ['meeting_title', 'title', 'meeting.title', 'recording.title']);
  const startedAt = pick(payload, ['meeting_started_at', 'started_at', 'meeting.started_at', 'recording.started_at', 'created_at']);
  const transcript = pick(payload, ['transcript', 'transcript.text', 'recording.transcript']);
  const summary = pick(payload, ['summary', 'ai_summary', 'recording.summary', 'summary.markdown_formatted']);
  const actionItems = pick(payload, ['action_items', 'ai_action_items', 'recording.action_items']);
  const inviteesRaw = pick(payload, ['invitees', 'attendees', 'meeting.invitees', 'recording.invitees', 'calendar_invitees']) || [];
  const invitees = Array.isArray(inviteesRaw) ? inviteesRaw : [];
  const emails = invitees
    .map((inv) => (typeof inv === 'string' ? inv : inv?.email))
    .filter(Boolean)
    .map((e) => String(e).toLowerCase());

  return { recordingId, title, startedAt, transcript, summary, actionItems, emails };
}

// Best-effort match: an invitee email that's a known client, narrowed to
// whichever of that client's appointments starts closest to the meeting's
// own start time (within 3h either side — generous enough for a reschedule
// that didn't propagate, tight enough to not grab an unrelated old meeting).
// Never guesses across multiple matching clients — 'ambiguous' surfaces in
// the CRM rather than silently attaching a transcript to the wrong person.
export function matchFathomCall({ emails, startedAt }) {
  if (!emails.length) return { client: null, appointment: null, order: null, matchStatus: 'unmatched' };

  const placeholders = emails.map(() => '?').join(',');
  const clients = db.prepare(`SELECT * FROM clients WHERE lower(email) IN (${placeholders})`).all(...emails);
  if (clients.length === 0) return { client: null, appointment: null, order: null, matchStatus: 'unmatched' };
  if (clients.length > 1) return { client: null, appointment: null, order: null, matchStatus: 'ambiguous' };

  const client = clients[0];
  const appointments = db.prepare('SELECT * FROM appointments WHERE client_id = ? ORDER BY starts_at DESC').all(client.id);

  let appointment = null;
  if (startedAt && appointments.length) {
    const target = new Date(startedAt).getTime();
    let bestDiff = Infinity;
    for (const a of appointments) {
      const diff = Math.abs(new Date(a.starts_at).getTime() - target);
      if (diff < bestDiff) { bestDiff = diff; appointment = a; }
    }
    const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
    if (bestDiff > THREE_HOURS_MS) appointment = null;
  } else if (appointments.length === 1) {
    appointment = appointments[0];
  }

  const order = appointment?.order_id
    ? db.prepare('SELECT * FROM orders WHERE id = ?').get(appointment.order_id)
    : db.prepare('SELECT * FROM orders WHERE client_id = ? ORDER BY created_at DESC LIMIT 1').get(client.id);

  return { client, appointment, order: order || null, matchStatus: appointment ? 'matched' : 'ambiguous' };
}

// Idempotent on fathom_recording_id (Fathom, like Stripe, may retry a
// webhook delivery) — a second delivery for the same recording is a no-op
// rather than a duplicate row or a thrown unique-constraint error.
export function storeFathomCall({ rawPayload, fields, match }) {
  if (fields.recordingId) {
    const existing = db.prepare('SELECT id FROM call_transcripts WHERE fathom_recording_id = ?').get(fields.recordingId);
    if (existing) return existing.id;
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO call_transcripts (
      id, fathom_recording_id, appointment_id, client_id, order_id,
      meeting_title, meeting_started_at, invitee_emails,
      transcript, summary, action_items, match_status, raw_payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    fields.recordingId || null,
    match.appointment?.id || null,
    match.client?.id || null,
    match.order?.id || null,
    fields.title || null,
    fields.startedAt || null,
    JSON.stringify(fields.emails || []),
    typeof fields.transcript === 'string' ? fields.transcript : JSON.stringify(fields.transcript ?? null),
    typeof fields.summary === 'string' ? fields.summary : JSON.stringify(fields.summary ?? null),
    JSON.stringify(fields.actionItems ?? null),
    match.matchStatus,
    JSON.stringify(rawPayload),
  );
  return id;
}
