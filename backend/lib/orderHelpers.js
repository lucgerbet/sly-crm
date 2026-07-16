import { randomUUID } from 'node:crypto';
import db from '../db.js';

// Server-to-server callers (sly-shop, the Calendly widget's fallback POST,
// the future order-taking tool) aren't human browser sessions and can't use
// the Traefik Basic Auth login — they authenticate with a shared secret
// checked here instead. Traefik only strips Basic Auth for these paths
// (see docker-compose.yml); this check is the real security boundary.
export function requireIntakeSecret(req, res, next) {
  const expected = process.env.SLY_INTAKE_SECRET;
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!expected || got !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Find a client by case-insensitive email match, or create one. Never
// overwrites fields a human may have already edited in the CRM (tags,
// notes, assigned_to, potential) — only fills identity fields if blank, and
// only stamps `source` on brand-new clients so a repeat shop customer who
// was manually tagged/assigned doesn't get clobbered by every new order.
export function findOrCreateClient({ name, email, source }) {
  const existing = db.prepare('SELECT * FROM clients WHERE lower(email) = lower(?)').get(email);
  if (existing) {
    const [first_name, ...rest] = (name || '').trim().split(/\s+/);
    const last_name = rest.join(' ');
    const setClauses = [];
    const values = [];
    if (!existing.first_name && first_name) { setClauses.push('first_name = ?'); values.push(first_name); }
    if (!existing.last_name && last_name) { setClauses.push('last_name = ?'); values.push(last_name); }
    if (setClauses.length) {
      setClauses.push("updated_at = datetime('now')");
      values.push(existing.id);
      db.prepare(`UPDATE clients SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
    }
    return db.prepare('SELECT * FROM clients WHERE id = ?').get(existing.id);
  }

  const [first_name, ...rest] = (name || '').trim().split(/\s+/);
  const last_name = rest.join(' ');
  const id = randomUUID();
  db.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, source)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, first_name || '', last_name || '', email || '', source || '');
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
}

export function formatMoney(cents, currency = '€') {
  if (cents == null) return '—';
  return `${currency} ${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Turns the ~30-field shop Config object into a readable "Label: value" block
// for the order recap email. Generic camelCase -> Title Case humanizer rather
// than a hand-maintained field-by-field map — keeps this in sync automatically
// as sly-shop's Config shape evolves, at the cost of slightly generic labels.
export function summarizeConfig(configJson) {
  let config;
  try { config = typeof configJson === 'string' ? JSON.parse(configJson) : configJson; }
  catch { return ''; }
  if (!config || typeof config !== 'object') return '';

  const skip = new Set(['name', 'email', 'message']);
  const lines = [];
  for (const [key, value] of Object.entries(config)) {
    if (skip.has(key)) continue;
    if (value === '' || value === null || value === undefined || value === false) continue;
    const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
    lines.push(`${label}: ${value === true ? 'Yes' : value}`);
  }
  return lines.join('\n');
}

// Atomically increments settings.order_number_seq and returns a human
// reference like "SLY-2026-0001". Uses the current UTC year, resets are not
// automatic across years by design (sequence just keeps climbing) — fine for
// a low-volume bespoke business, avoids the complexity of per-year resets.
export function nextOrderNumber() {
  const year = new Date().toISOString().slice(0, 4);
  const row = db.prepare("UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'order_number_seq' RETURNING value").get();
  const seq = row?.value ?? 1;
  return `SLY-${year}-${String(seq).padStart(4, '0')}`;
}

// Mirrors sly-shop's src/lib/pricing.ts PRICES labels — kept as a small
// duplicated map rather than a cross-repo import (sly-shop is a separate
// Vercel deployment); update both sides if product types ever change.
export const PRODUCT_LABELS = {
  suit: 'Costume Deux Pièces',
  blazer: 'Blazer sur mesure',
  trousers: 'Pantalon sur mesure',
};

export function productLabel(type) {
  return PRODUCT_LABELS[type] || type || 'your order';
}

// Formats an ISO UTC instant for display in emails, in the shop's operating
// timezone (matches TZ=Europe/Paris already set in docker-compose.yml).
export function formatAppointmentDate(startsAt) {
  return new Date(startsAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
}
export function formatAppointmentTime(startsAt) {
  return new Date(startsAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris', timeZoneName: 'short' });
}

export function logMessage(clientId, type, content) {
  db.prepare('INSERT INTO messages (id, client_id, type, content, date) VALUES (?, ?, ?, ?, ?)')
    .run(randomUUID(), clientId, type, content, new Date().toISOString());
}
