import PDFDocument from 'pdfkit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatMoney, PRODUCT_LABELS } from './orderHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// PDFKit's base14 fonts (Helvetica etc.) have no CJK glyphs and silently
// render garbage instead of throwing — the production order form is
// bilingual FR/EN/CN (matches the workshop's own docket), so it needs a
// font with full Latin + CJK coverage. Noto Sans SC (SIL OFL) covers both,
// so one font works for the whole document instead of switching per-run.
const NOTO_SANS_SC_PATH = path.resolve(__dirname, '../assets/fonts/NotoSansSC.ttf');

// Renders the same human-readable [label, value] rows sly-shop shows on its
// "Coordonnées" step (passed through intake as `config_summary`) into a
// clean PDF, attached to the appointment-confirmation email so the client
// has a written record of their preselection ahead of the call with Luc.
export function buildOrderRecapPdf({ productLabel, rows, appointmentDate, appointmentTime }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(18).fillColor('#1A1A1A').text('SLY ATELIER');
    doc.font('Helvetica').fontSize(11).fillColor('#666666').text('Récapitulatif de présélection');
    doc.moveDown(1.2);

    doc.font('Helvetica-Bold').fontSize(14).fillColor('#1A1A1A').text(productLabel || 'Commande');
    if (appointmentDate && appointmentTime) {
      doc.font('Helvetica').fontSize(10).fillColor('#666666')
        .text(`Rendez-vous : ${appointmentDate} à ${appointmentTime}`);
    }
    doc.moveDown(1);

    doc.moveTo(doc.page.margins.left, doc.y)
      .lineTo(doc.page.width - doc.page.margins.right, doc.y)
      .strokeColor('#DDDDDD').stroke();
    doc.moveDown(0.8);

    for (const [label, value] of rows || []) {
      if (doc.y > doc.page.height - doc.page.margins.bottom - 50) doc.addPage();
      doc.font('Helvetica').fontSize(8.5).fillColor('#888888').text(String(label).toUpperCase(), { characterSpacing: 0.5 });
      doc.font('Helvetica').fontSize(11).fillColor('#1A1A1A').text(String(value ?? '—'));
      doc.moveDown(0.6);
    }

    doc.moveDown(1);
    doc.font('Helvetica').fontSize(9).fillColor('#999999')
      .text('Rien n\'est définitif ici — chaque détail est confirmé avec Luc au rendez-vous, tissus en main.');

    doc.end();
  });
}

// [cnLabel, enLabel, finalJacket key] — matches FinalJacketMeasurements in
// sly-suit-meeting/src/types.ts (2026-08-09 measurements rebuild: final
// garment patronage, separate from raw body measurements). Two length rows
// (front/back) replace the old single 衣长 row — the front/back split
// matters (see Chacon/Singh discussions on posture-dependent asymmetry).
// 领围 Neck has no final-jacket equivalent in the new model (Fusari's own
// system doesn't collar-fit a jacket either) — pulled from bodyMeasurements
// instead, labeled accordingly. Old rows with no surviving data source
// (front chest / breast height / back width / jacket hem width) are gone.
const JACKET_MEASUREMENT_ROWS = [
  ['肩宽', 'Shoulder', (fj) => fj.shoulder],
  ['袖长', 'Sleeve', (fj) => fj.sleeveLength],
  ['前衣长', 'Length (front)', (fj) => fj.lengthFront],
  ['后衣长', 'Length (back)', (fj) => fj.lengthBack],
  ['胸围', 'Bust', (fj) => fj.chest],
  ['中腰', 'Waist', (fj) => fj.waist],
  ['肚围', 'Stomach', (fj) => fj.stomach],
  ['臀围', 'Hips', (fj) => fj.hips],
  ['臂围', 'Arm width', (fj) => fj.armWidth],
  ['袖圈', 'Arm hole', (fj) => fj.armHole],
  ['袖口', 'Sleeve opening', (fj) => fj.sleeveOpening],
];

// [cnLabel, enLabel, finalPant key] — matches FinalPantMeasurements.
const TROUSER_MEASUREMENT_ROWS = [
  ['裤长', 'Length', (fp) => fp.length],
  ['腰围', 'Waist', (fp) => fp.waist],
  ['臀围', 'Hip', (fp) => fp.hip],
  ['横裆', 'Thigh', (fp) => fp.thigh],
  ['中裆', 'Knee', (fp) => fp.knee],
  ['直裆', 'Whole crotch', (fp) => fp.wholeCrotch],
  ['小腿', 'Calf', (fp) => fp.calf],
  ['裤脚', 'Cuff opening', (fp) => fp.cuffOpening],
];

// Replicates the production workshop's own paper order docket (see the
// scanned template Luc shared) so it's immediately recognizable to them —
// same bilingual CN/EN field names, same grouping. Built from finalConfig
// (order.config_json, set by sly-suit-meeting's buildFinalConfig at finalize
// time), not from configSummary, since it needs raw per-field values rather
// than pre-joined display strings. Sent to Luc for review, never straight to
// the workshop — he forwards it himself once he's checked it.
export function buildProductionOrderPdf({ order, client, config, currency }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: 'A4' });
    doc.registerFont('CJK', NOTO_SANS_SC_PATH);
    doc.font('CJK'); // single weight available — hierarchy comes from font size, not bold
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const money = (cents) => formatMoney(cents, currency);
    const bodyMeasurements = config?.bodyMeasurements || {};
    const finalJacket = config?.finalJacket || {};
    const finalPant = config?.finalPant || {};
    const trousers = config?.trousers || {};

    doc.fontSize(16).fillColor('#1A1A1A').text('SLY ATELIER — 生产订单 PRODUCTION ORDER');
    doc.fontSize(9).fillColor('#999999')
      .text('À vérifier avant envoi à l\'atelier de production — Please review before sending to the workshop');
    doc.moveDown(1);

    doc.fontSize(10).fillColor('#1A1A1A')
      .text(`CUSTOMER 客户: ${client?.first_name || ''} ${client?.last_name || ''}`.trim());
    doc.text(`TEL 电话: ${client?.phone || '—'}    单号 ORDER NO.: ${order.order_number || order.id}`);
    if (config?.stylistName) doc.text(`经手人 HANDLED BY: ${config.stylistName}`);
    doc.moveDown(0.6);

    doc.fontSize(10)
      .text(`合计 TOTAL: ${money((order.deposit_amount_cents || 0) + (order.balance_amount_cents || 0))}    `
        + `已收定金 DEPOSIT: ${money(order.deposit_amount_cents)}    `
        + `尚欠 BALANCE: ${money(order.balance_amount_cents)}`);
    doc.moveDown(1);

    doc.moveTo(doc.page.margins.left, doc.y)
      .lineTo(doc.page.width - doc.page.margins.right, doc.y)
      .strokeColor('#DDDDDD').stroke();
    doc.moveDown(0.8);

    const piece = [config?.jacket ? 'Blazer/Veste' : null, trousers && Object.keys(trousers).length ? 'Pantalon' : null]
      .filter(Boolean).join(' + ') || config?.productType || '—';
    doc.fontSize(11).fillColor('#1A1A1A').text(`PIÈCE 部位: ${piece}`);
    if (config?.fabricName) {
      const customTag = config?.fabricIsCustom ? ' [PERSONNALISÉ — hors bibliothèque / CUSTOM]' : '';
      doc.fontSize(10).fillColor('#333333').text(`Tissu 面料: ${config.fabricName} (${config.fabricReference || '—'})${customTag}`);
    }
    doc.moveDown(0.8);

    // 版型 fit preference — replaces the old body-check tick-boxes (removed
    // 2026-08-09 along with the rest of the 9-dropdown "body check").
    doc.fontSize(10).fillColor('#1A1A1A').text(`版型 FIT PREFERENCE: ${config?.fitPreference || '—'}`);
    doc.moveDown(0.6);

    if (Object.values(bodyMeasurements).some(Boolean)) {
      doc.fontSize(10).fillColor('#1A1A1A').text('原始体型尺寸 BODY MEASUREMENTS (cm)');
      doc.fontSize(9.5).fillColor('#333333');
      doc.text(`领围 Neck: ${bodyMeasurements.neck || '—'}`);
      doc.moveDown(0.6);
    }

    if (config?.jacket && Object.values(finalJacket).some(Boolean)) {
      doc.fontSize(10).fillColor('#1A1A1A').text('尺寸 — 上身 FINAL JACKET MEASUREMENTS (cm)');
      doc.fontSize(9.5).fillColor('#333333');
      for (const [cn, en, get] of JACKET_MEASUREMENT_ROWS) {
        doc.text(`${cn} ${en}: ${get(finalJacket) || '—'}`);
      }
      doc.moveDown(0.6);
      if (finalJacket.comment) {
        doc.fontSize(9.5).fillColor('#8C3B3B').text(`⚠ ${finalJacket.comment}`, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
        doc.moveDown(0.6);
      }
    }

    if (trousers && (trousers.pleats || trousers.cuff || Object.values(finalPant).some(Boolean))) {
      doc.fontSize(10).fillColor('#1A1A1A').text('尺寸 — 裤子 FINAL TROUSER MEASUREMENTS (cm)');
      doc.fontSize(9.5).fillColor('#333333');
      for (const [cn, en, get] of TROUSER_MEASUREMENT_ROWS) {
        doc.text(`${cn} ${en}: ${get(finalPant) || '—'}`);
      }
      doc.text(`脚口款式 Style hem width: ${trousers.hemWidthCm || '—'}`);
      doc.text(`褶 Pleat: ${trousers.pleats || '—'}`);
      doc.text(`翻边 Cuff: ${trousers.cuff || '—'}`);
      doc.moveDown(0.6);
      if (finalPant.comment) {
        doc.fontSize(9.5).fillColor('#8C3B3B').text(`⚠ ${finalPant.comment}`, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
        doc.moveDown(0.6);
      }
    }

    if (config?.generalNotes) {
      doc.fontSize(10).fillColor('#1A1A1A').text('备注 NOTES');
      doc.fontSize(9.5).fillColor('#333333').text(config.generalNotes);
      doc.moveDown(0.6);
    }

    doc.moveDown(0.6);
    doc.fontSize(8.5).fillColor('#999999')
      .text('订单日期 Order date: ______ / ______ / ______      试样日期 Sample date: ______ / ______ / ______      取货日期 Pickup date: ______ / ______ / ______');

    doc.end();
  });
}

// Accounting-grade invoice, one per order — invoice number = order_number
// (Luc's choice: one sequence, not a separate invoice-numbering scheme).
// Pulls seller identity from `settings` (business_legal_name/address/siret/
// vat_mention) rather than hardcoding it, since none of that was confirmed
// at build time (2026-08-12) — business_vat_mention defaults to an loud,
// unmissable placeholder rather than guessing a real "TVA non applicable"
// or VAT-rate mention, because a wrong tax mention on a real invoice is a
// genuine legal/accounting problem, not a cosmetic one. DO NOT send an
// invoice to a real client until settings.business_vat_mention has been
// confirmed with Luc's accountant and set to the real mention.
export function buildInvoicePdf({ order, client, settings }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56, size: 'A4' });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const money = (cents) => formatMoney(cents, settings.currency);
    const invoiceNumber = order.order_number || order.id;
    const issueDate = new Date().toLocaleDateString('fr-FR');
    const saleDate = order.created_at
      ? new Date(order.created_at).toLocaleDateString('fr-FR')
      : issueDate;
    const totalCents = (order.deposit_amount_cents || 0) + (order.balance_amount_cents || 0);
    const productLabel = PRODUCT_LABELS[order.product_type] || order.product_type || 'Commande sur mesure';
    const vatMention = settings.business_vat_mention
      || '[MENTION TVA À CONFIRMER AVEC VOTRE COMPTABLE — ne pas envoyer telle quelle]';

    doc.font('Helvetica-Bold').fontSize(20).fillColor('#1A1A1A').text('FACTURE');
    doc.font('Helvetica').fontSize(10).fillColor('#666666')
      .text(`N° ${invoiceNumber}    ·    Date d'émission : ${issueDate}    ·    Date de vente : ${saleDate}`);
    doc.moveDown(1.4);

    // Seller / Client, side by side.
    const colWidth = (doc.page.width - doc.page.margins.left - doc.page.margins.right - 24) / 2;
    const topY = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#999999').text('VENDEUR', doc.page.margins.left, topY, { width: colWidth, characterSpacing: 0.5 });
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1A1A1A').text(settings.business_legal_name || '[Nom légal de l\'entreprise à renseigner]', { width: colWidth });
    doc.font('Helvetica').fontSize(9.5).fillColor('#333333');
    if (settings.business_address) doc.text(settings.business_address, { width: colWidth });
    else doc.fillColor('#B23B3B').text('[Adresse à renseigner]', { width: colWidth });
    doc.fillColor('#333333').text(settings.business_siret ? `SIRET : ${settings.business_siret}` : '[SIRET à renseigner]', { width: colWidth });
    doc.fillColor(settings.business_vat_mention ? '#333333' : '#B23B3B').fontSize(8.5).text(vatMention, { width: colWidth });

    const clientX = doc.page.margins.left + colWidth + 24;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#999999').text('CLIENT', clientX, topY, { width: colWidth, characterSpacing: 0.5 });
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1A1A1A').text(`${client?.first_name || ''} ${client?.last_name || ''}`.trim() || '—', clientX, doc.y, { width: colWidth });
    doc.font('Helvetica').fontSize(9.5).fillColor('#333333');
    if (client?.city || client?.country) doc.text([client.city, client.country].filter(Boolean).join(', '), clientX, doc.y, { width: colWidth });
    if (client?.email) doc.text(client.email, clientX, doc.y, { width: colWidth });

    doc.y = Math.max(doc.y, topY + 90);
    doc.moveDown(1);
    doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#DDDDDD').stroke();
    doc.moveDown(1);

    // Line item — one row, this is a single made-to-measure piece per order.
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#999999').text('DÉSIGNATION', { characterSpacing: 0.5 });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(11).fillColor('#1A1A1A').text(`1 × ${productLabel}`, { continued: false });
    doc.moveDown(0.8);
    doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#DDDDDD').stroke();
    doc.moveDown(0.8);

    const totalsRight = doc.page.width - doc.page.margins.right;
    const row = (label, value, opts = {}) => {
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.bold ? 12 : 10.5).fillColor('#1A1A1A');
      doc.text(label, doc.page.margins.left, doc.y, { continued: true, width: 300 });
      doc.text(value, { align: 'right', width: totalsRight - doc.page.margins.left - 300 });
    };
    row('Total', money(totalCents), { bold: true });
    row('Acompte déjà réglé', money(order.deposit_amount_cents));
    row('Solde à régler', money(order.balance_amount_cents), { bold: true });
    doc.moveDown(1.4);

    doc.font('Helvetica').fontSize(8.5).fillColor('#999999').text(
      "Conditions de paiement : solde à régler à réception de la facture. En cas de retard de paiement, une pénalité "
      + "sera appliquée conformément à l'article L441-10 du Code de commerce, ainsi qu'une indemnité forfaitaire de "
      + "40 € pour frais de recouvrement.",
      { width: totalsRight - doc.page.margins.left },
    );

    doc.end();
  });
}
