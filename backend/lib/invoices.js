// Issuing invoices — the one place in the CRM that produces a legal document.
//
// Three rules govern everything below, and each one exists because breaking
// it is what fails an audit:
//
//   1. An invoice is a snapshot. Every value on it is copied at issue time and
//      the PDF is written once. Nothing here ever re-renders an old invoice
//      from live data.
//   2. Numbers are chronological and gap-free within a year. The counter is
//      bumped inside the same transaction that inserts the row, so a number
//      can never be taken twice or skipped.
//   3. Nothing is issued while the seller identity is incomplete. A missing
//      SIRET produces a refusal, never a placeholder on a real document.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import db from '../db.js';
import { getSettings } from '../routes/settings.js';
import { buildInvoicePdf } from './pdf.js';
import { logMessage } from './orderHelpers.js';
import { catalogue } from '../routes/products.js';

export const INVOICE_KINDS = ['deposit', 'balance'];

// Where PDFs live. Next to the database, so the Docker volume that persists
// one persists the other — an invoice whose PDF vanished on redeploy is not
// an invoice.
export function invoicesDir() {
  const dbPath = process.env.DATABASE_PATH || './sly_crm.db';
  return path.join(path.dirname(path.resolve(dbPath)), 'invoices');
}

// What must be true of the seller before anything can be issued.
export function legalReadiness(settings = getSettings()) {
  const missing = [];
  if (!settings.business_legal_name?.trim()) missing.push('business_legal_name');
  if (!settings.business_address?.trim()) missing.push('business_address');
  if (!/^\d{14}$/.test(settings.business_siret || '')) missing.push('business_siret');
  if (!settings.business_vat_mention?.trim()) missing.push('business_vat_mention');
  return { ready: missing.length === 0, missing };
}

function sellerSnapshot(settings) {
  return {
    legalName: settings.business_legal_name.trim(),
    address: settings.business_address.trim(),
    siret: settings.business_siret.trim(),
    vatMention: settings.business_vat_mention.trim(),
    email: 'contact@sly-atelier.com',
  };
}

function clientSnapshot(client) {
  return {
    name: [client?.first_name, client?.last_name].filter(Boolean).join(' ').trim() || '—',
    address: client?.address || [client?.city, client?.country].filter(Boolean).join(', ') || null,
    email: client?.email || null,
  };
}

// The number, allocated atomically. Returns { number, year, n }.
const allocate = db.transaction((year) => {
  db.prepare('INSERT OR IGNORE INTO invoice_counters (year, last_n) VALUES (?, 0)').run(year);
  db.prepare('UPDATE invoice_counters SET last_n = last_n + 1 WHERE year = ?').run(year);
  const { last_n } = db.prepare('SELECT last_n FROM invoice_counters WHERE year = ?').get(year);
  return { number: `SLY-${year}-F-${String(last_n).padStart(4, '0')}`, year, n: last_n };
});

// Hands a number back if the invoice it was reserved for never came to be
// (PDF generation failed, disk full…). Only when it is still the latest one:
// a later invoice may already have taken the next number, and pulling one
// out from underneath it would create exactly the gap this exists to avoid.
const release = db.transaction((year, n) => {
  const row = db.prepare('SELECT last_n FROM invoice_counters WHERE year = ?').get(year);
  if (row && row.last_n === n) {
    db.prepare('UPDATE invoice_counters SET last_n = last_n - 1 WHERE year = ?').run(year);
    return true;
  }
  return false;
});

// Issues one invoice for an order. Idempotent on (order, kind): a webhook
// that fires twice must not produce two invoices.
//
// `issuedAt` defaults to now but is accepted as a parameter so the invoices
// for orders paid before this module existed can carry their real payment
// date rather than the day of the backfill.
export async function issueInvoice({ orderId, kind, paymentRef = null, paidAt = null, issuedAt = null }) {
  if (!INVOICE_KINDS.includes(kind)) throw new Error(`Unknown invoice kind: ${kind}`);

  const existing = db.prepare('SELECT * FROM invoices WHERE order_id = ? AND kind = ?').get(orderId, kind);
  if (existing) return { invoice: existing, created: false };

  const settings = getSettings();
  const readiness = legalReadiness(settings);
  if (!readiness.ready) {
    const err = new Error(`Seller identity incomplete: ${readiness.missing.join(', ')}`);
    err.code = 'LEGAL_NOT_READY';
    throw err;
  }

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new Error('Order not found');
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(order.client_id);

  // What is being invoiced. The deposit invoice bills the reservation; the
  // balance invoice bills the whole piece and deducts what was already paid —
  // that is how an acompte is presented on French invoices.
  const productLabel = catalogue().find((p) => p.key === order.product_type)?.label
    || order.product_type || 'Pièce sur mesure';
  const deposit = order.deposit_amount_cents || 0;
  const total = deposit + (order.balance_amount_cents || 0);

  // Invoices here are issued on payment and say "Réglée le". One for money
  // that has not arrived would carry a false payment line, so the payment
  // must have cleared — the webhook is the normal caller and guarantees it,
  // but the rule lives here so no other caller can get it wrong.
  if (kind === 'deposit' && order.deposit_status !== 'paid') {
    throw new Error('Deposit not paid — nothing to invoice yet');
  }
  if (kind === 'balance' && order.balance_status !== 'paid') {
    throw new Error('Balance not paid — nothing to invoice yet');
  }

  let lines, subtotal, alreadyPaid, due;
  if (kind === 'deposit') {
    lines = [{ label: `Acompte — ${productLabel}`, qty: 1, unit_cents: deposit, total_cents: deposit }];
    subtotal = deposit; alreadyPaid = 0; due = deposit;
  } else {
    if (!order.balance_amount_cents) {
      throw new Error('No balance recorded on this order — was the fitting call closed?');
    }
    lines = [{ label: `1 × ${productLabel} sur mesure`, qty: 1, unit_cents: total, total_cents: total }];
    subtotal = total; alreadyPaid = deposit; due = total - deposit;
  }

  const issued = issuedAt ? new Date(issuedAt) : new Date();
  if (Number.isNaN(issued.getTime())) throw new Error('Invalid issue date');
  const { number, year, n } = allocate(issued.getFullYear());

  const snapshot = {
    id: randomUUID(),
    number, seq_year: year, seq_n: n, kind,
    order_id: order.id, client_id: order.client_id,
    issued_at: issued.toISOString(),
    sale_date: order.created_at || null,
    seller: sellerSnapshot(settings),
    client: clientSnapshot(client),
    lines,
    subtotal_cents: subtotal,
    // Franchise en base: no VAT line, TTC equals HT. The mention on the
    // document is what makes that legal.
    vat_cents: 0,
    total_cents: subtotal,
    already_paid_cents: alreadyPaid,
    due_cents: due,
    vat_mention: settings.business_vat_mention.trim(),
    payment_ref: paymentRef,
    paid_at: paidAt || issued.toISOString(),
    order_number: order.order_number,
  };

  const dir = path.join(invoicesDir(), String(year));
  const pdfPath = path.join(dir, `${number}.pdf`);
  try {
    const pdf = await buildInvoicePdf({ invoice: snapshot, settings });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(pdfPath, pdf);

    db.prepare(`
      INSERT INTO invoices (id, number, seq_year, seq_n, kind, order_id, client_id, issued_at, sale_date,
        seller_json, client_json, lines_json, subtotal_cents, vat_cents, total_cents,
        already_paid_cents, due_cents, vat_mention, payment_ref, paid_at, pdf_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.id, number, year, n, kind, order.id, order.client_id, snapshot.issued_at, snapshot.sale_date,
      JSON.stringify(snapshot.seller), JSON.stringify(snapshot.client), JSON.stringify(lines),
      subtotal, 0, subtotal, alreadyPaid, due, snapshot.vat_mention, paymentRef, snapshot.paid_at, pdfPath,
    );
  } catch (e) {
    // The file may have been written before the row insert failed; neither
    // half may survive alone.
    try { fs.unlinkSync(pdfPath); } catch (_) { /* never written */ }
    release(year, n);
    throw e;
  }

  logMessage(order.client_id, 'invoice_issued',
    `Facture ${kind === 'deposit' ? "d'acompte" : 'de solde'} ${number} émise — ${(due / 100).toFixed(2)} €`);

  return { invoice: db.prepare('SELECT * FROM invoices WHERE id = ?').get(snapshot.id), created: true };
}

// Rehydrates a stored row into the shape the PDF builder and the UI read.
export function parseInvoice(row) {
  if (!row) return null;
  return {
    ...row,
    seller: JSON.parse(row.seller_json || '{}'),
    client: JSON.parse(row.client_json || '{}'),
    lines: JSON.parse(row.lines_json || '[]'),
  };
}
