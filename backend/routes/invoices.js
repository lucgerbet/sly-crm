// The invoice library — every invoice ever issued, and the monthly bundle the
// accountant actually wants.
//
// Read-only by design, apart from the backfill. Invoices are issued by the
// payment webhooks (see routes/webhooks.js) and never edited here: an invoice
// that can be changed after the fact is not an invoice.
import { Router } from 'express';
import fs from 'node:fs';
import JSZip from 'jszip';
import db from '../db.js';
import { getSettings } from './settings.js';
import { issueInvoice, legalReadiness, parseInvoice } from '../lib/invoices.js';

const router = Router();

const KIND_LABEL = { deposit: 'Acompte', balance: 'Solde' };

function listRows({ year, month, q }) {
  const where = [];
  const params = [];
  if (year) { where.push("strftime('%Y', i.issued_at) = ?"); params.push(String(year)); }
  if (month) { where.push("strftime('%m', i.issued_at) = ?"); params.push(String(month).padStart(2, '0')); }
  if (q) {
    where.push('(i.number LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ? OR c.email LIKE ? OR o.order_number LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  return db.prepare(`
    SELECT i.*, o.order_number, c.first_name, c.last_name, c.email
    FROM invoices i
    JOIN orders o ON o.id = i.order_id
    LEFT JOIN clients c ON c.id = i.client_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY i.seq_year DESC, i.seq_n DESC
  `).all(...params);
}

// GET /api/invoices?year=&month=&q=
router.get('/', (req, res) => {
  const rows = listRows(req.query).map((r) => ({
    ...parseInvoice(r),
    kind_label: KIND_LABEL[r.kind] || r.kind,
  }));

  // Which months exist, so the UI can offer a picker built from real data
  // rather than twelve mostly-empty options.
  const months = db.prepare(`
    SELECT strftime('%Y', issued_at) AS year, strftime('%m', issued_at) AS month,
           COUNT(*) AS n, SUM(due_cents) AS cents
    FROM invoices GROUP BY year, month ORDER BY year DESC, month DESC
  `).all();

  res.json({
    data: rows,
    months,
    totalCents: rows.reduce((a, r) => a + (r.due_cents || 0), 0),
    legal: legalReadiness(getSettings()),
  });
});

// GET /api/invoices/:id/pdf — the stored file, exactly as issued.
router.get('/:id/pdf', (req, res) => {
  const row = db.prepare('SELECT * FROM invoices WHERE id = ? OR number = ?').get(req.params.id, req.params.id);
  if (!row) return res.status(404).json({ error: 'Facture introuvable' });
  if (!fs.existsSync(row.pdf_path)) {
    // The row is the legal record; a missing file is an operations problem
    // worth a loud error, not a silent re-render that would hide it.
    return res.status(500).json({ error: `Fichier PDF absent du disque : ${row.pdf_path}` });
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${row.number}.pdf"`);
  fs.createReadStream(row.pdf_path).pipe(res);
});

// GET /api/invoices/export?year=2026&month=08 — one ZIP: every PDF of the
// month plus a CSV ledger. This is the hand-off to the accountant, so the
// CSV carries what reconciliation needs: number, date, client, amounts, kind,
// payment date and the Stripe reference.
router.get('/export', async (req, res) => {
  const { year, month } = req.query;
  if (!/^\d{4}$/.test(year || '') || !/^\d{1,2}$/.test(month || '')) {
    return res.status(400).json({ error: 'year et month sont requis' });
  }
  const rows = listRows({ year, month }).reverse(); // chronological in the ledger
  if (!rows.length) return res.status(404).json({ error: 'Aucune facture sur cette période' });

  const zip = new JSZip();
  const stamp = `${year}-${String(month).padStart(2, '0')}`;
  const folder = zip.folder(`factures-SLY-${stamp}`);

  // French CSV: semicolon-separated, decimal comma, UTF-8 BOM so Excel opens
  // it with accents intact.
  const eur = (cents) => ((cents || 0) / 100).toFixed(2).replace('.', ',');
  const csvLines = [
    ['Numéro', 'Type', 'Date émission', 'Client', 'Email', 'Commande', 'Montant TTC', 'Déjà réglé', 'Net facturé', 'TVA', 'Date paiement', 'Référence paiement'].join(';'),
  ];
  for (const r of rows) {
    const inv = parseInvoice(r);
    csvLines.push([
      inv.number,
      KIND_LABEL[inv.kind] || inv.kind,
      inv.issued_at.slice(0, 10),
      `"${(inv.client.name || '').replace(/"/g, '""')}"`,
      inv.client.email || '',
      inv.order_number || '',
      eur(inv.total_cents),
      eur(inv.already_paid_cents),
      eur(inv.due_cents),
      eur(inv.vat_cents),
      inv.paid_at ? inv.paid_at.slice(0, 10) : '',
      inv.payment_ref || '',
    ].join(';'));
    if (fs.existsSync(inv.pdf_path)) folder.file(`${inv.number}.pdf`, fs.readFileSync(inv.pdf_path));
  }
  folder.file(`grand-livre-${stamp}.csv`, '\uFEFF' + csvLines.join('\n'));

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="factures-SLY-${stamp}.zip"`);
  res.send(buffer);
});

// POST /api/invoices/backfill — issues the invoices that the payments made
// before this module existed never got. Dated at each real payment, and in
// payment order, so the sequence stays chronological. Idempotent: an order
// that already has its invoice is skipped, so running it twice is harmless.
router.post('/backfill', async (_req, res) => {
  const readiness = legalReadiness(getSettings());
  if (!readiness.ready) {
    return res.status(409).json({ error: `Identité vendeur incomplète : ${readiness.missing.join(', ')}` });
  }

  // One event per payment, then sorted by when it happened.
  const events = [];
  for (const o of db.prepare(`
    SELECT id, order_number, deposit_paid_at, balance_paid_at, deposit_status, balance_status,
           stripe_deposit_payment_intent_id, balance_stripe_session_id
    FROM orders
  `).all()) {
    if (o.deposit_status === 'paid' && o.deposit_paid_at) {
      events.push({ orderId: o.id, kind: 'deposit', at: o.deposit_paid_at, ref: o.stripe_deposit_payment_intent_id });
    }
    if (o.balance_status === 'paid' && o.balance_paid_at) {
      events.push({ orderId: o.id, kind: 'balance', at: o.balance_paid_at, ref: o.balance_stripe_session_id });
    }
  }
  events.sort((a, b) => new Date(a.at) - new Date(b.at));

  const issued = [], skipped = [], failed = [];
  for (const e of events) {
    try {
      const { invoice, created } = await issueInvoice({
        orderId: e.orderId, kind: e.kind, paymentRef: e.ref, paidAt: e.at, issuedAt: e.at,
      });
      (created ? issued : skipped).push(invoice.number);
    } catch (err) {
      failed.push({ orderId: e.orderId, kind: e.kind, error: err.message });
    }
  }
  res.json({ issued, skipped, failed });
});

export default router;
