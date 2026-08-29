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

// Same house palette as the branded client emails (lib/emailTemplate.js,
// itself lifted from sly-shop's globals.css) — the production order should
// read as the same brand, not a generic gray PDFKit default.
const PO_PALETTE = {
  offwhite: '#f8f4ef',
  white: '#ffffff',
  ink: '#1a1410',
  choco: '#3a2a23',
  cherry: '#5a1f24',
  border: '#e5ddd5',
  muted: '#6b5b4e',
};

// Approximate cm equivalents for the 3-way lapel-width category the app
// asks for (see sly-suit-meeting's shopConfigMapping.ts LAPEL_WIDTH_TO_WIDTH:
// 8,5cm→slim / 9,5cm→classic / 11cm→wide) — shown as a hint next to the
// category so the workshop gets a concrete number even though the exact cm
// value isn't itself stored on the order.
const LAPEL_WIDTH_CM = { slim: '~8,5cm', classic: '~9,5cm', wide: '~11cm' };

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

// [cnLabel, enLabel, bodyMeasurements key] — matches BodyMeasurements in
// sly-suit-meeting/src/types.ts. The raw body, distinct from the final
// garment rows above (which already have their own ease/aisance baked in) —
// the workshop needs both: the body to sanity-check the final patronage
// against, not just the finished numbers. Standard tailoring CN terms,
// reusing the same character choices as the jacket/trouser rows above where
// the same body part appears (袖圈/领围) — not independently verified with
// the workshop, flag if a term reads wrong to them.
const BODY_MEASUREMENT_ROWS = [
  ['肩宽', 'Shoulder', (bm) => bm.shoulder],
  ['胸围', 'Chest', (bm) => bm.chest],
  ['腰围（上衣）', 'Waist (jacket)', (bm) => bm.waistJacket],
  ['肚围', 'Stomach', (bm) => bm.stomach],
  ['臀围', 'Hips', (bm) => bm.hips],
  ['臂围', 'Biceps', (bm) => bm.biceps],
  ['前臂围', 'Forearm', (bm) => bm.forearm],
  ['手腕围', 'Wrist', (bm) => bm.wrist],
  ['袖圈', 'Armhole', (bm) => bm.armHole],
  ['领围', 'Neck', (bm) => bm.neck],
  ['腰围（裤）', 'Waist (trousers)', (bm) => bm.waistPant],
  ['侧颈点至上臀', 'Side neck to upper hip', (bm) => bm.sideNeckPointToUpperHips],
  ['大腿围', 'Thigh', (bm) => bm.thigh],
  ['膝围', 'Knee', (bm) => bm.knee],
  ['小腿围', 'Calf', (bm) => bm.calf],
  ['脚踝围', 'Ankle', (bm) => bm.ankle],
];

// Small-caps cherry eyebrow + short underline — same visual role as the
// branded email's section eyebrows, marking the start of a new group of
// fields rather than another wall of "label: value" prose.
function poSectionTitle(doc, cn, en) {
  if (doc.y > doc.page.margins.top) doc.moveDown(0.9);
  doc.fontSize(9).fillColor(PO_PALETTE.cherry).text(`${cn}  ${en}`, { characterSpacing: 0.6 });
  const ruleY = doc.y + 2;
  doc.moveTo(doc.page.margins.left, ruleY).lineTo(doc.page.margins.left + 26, ruleY)
    .strokeColor(PO_PALETTE.cherry).lineWidth(1.2).stroke();
  doc.y = ruleY + 10;
}

// Height a poRowAt() cell would need, without drawing anything — lets
// callers that place more than one cell per line (poMeasurementGrid) decide
// on ONE shared page-break before drawing either cell.
function poRowHeight(doc, label, display, width) {
  const labelWidth = Math.round(width * 0.44);
  const valueWidth = width - labelWidth - 10;
  const labelH = doc.heightOfString(String(label), { width: labelWidth, fontSize: 8 });
  const valueH = doc.heightOfString(display, { width: valueWidth, fontSize: 9.5 });
  return Math.max(labelH, valueH, 11);
}

// Draws one label/value cell at the CURRENT doc.y, with no page-break logic
// of its own — the caller (poRow, or poMeasurementGrid for a pair) has
// already decided where this lands.
function poRowAt(doc, label, display, x, width, rowH) {
  const labelWidth = Math.round(width * 0.44);
  const valueWidth = width - labelWidth - 10;
  const y = doc.y;
  doc.fontSize(8).fillColor(PO_PALETTE.muted).text(String(label), x, y, { width: labelWidth });
  doc.fontSize(9.5).fillColor(PO_PALETTE.ink).text(display, x + labelWidth + 10, y, { width: valueWidth });
  const bottomY = y + rowH + 5;
  doc.moveTo(x, bottomY).lineTo(x + width, bottomY).strokeColor(PO_PALETTE.border).lineWidth(0.5).stroke();
  return bottomY + 5;
}

// One label/value row, laid out like the branded email's detail table
// (muted uppercase-weight label on the left, ink value on the right) —
// replaces the old single "标签 Label: value" prose line. Skips itself
// entirely when value is empty UNLESS opts.force is set, in which case it
// renders an em-dash instead — used for fields whose absence is itself
// meaningful (e.g. a missing delivery address should be visibly flagged,
// not silently dropped from the document).
function poRow(doc, label, value, opts = {}) {
  if (!value && !opts.force) return;
  const display = value ? String(value) : '—';
  const x = opts.x ?? doc.page.margins.left;
  const width = opts.width ?? (doc.page.width - doc.page.margins.left - doc.page.margins.right);
  // Measure BEFORE drawing anything, and break to a fresh page ourselves if
  // the row wouldn't fit — PDFKit's own auto-pagination only kicks in for
  // implicit-flow text, not the explicit x/y calls poRowAt makes, so
  // without this a row that straddles a page boundary ends up with its
  // label on one page and its value alone on the next.
  const rowH = poRowHeight(doc, label, display, width);
  if (doc.y + rowH + 5 > doc.page.height - doc.page.margins.bottom) doc.addPage();
  doc.y = poRowAt(doc, label, display, x, width, rowH);
}

// Two-up layout for the longer measurement lists (up to 16 rows) — halves
// the vertical space a single column would take, which is most of the
// "hard to scan" complaint against the old wall-of-text version. Returns
// false (renders nothing) when every row in `entries` is empty, so callers
// can skip the section heading too rather than printing an empty table.
// Each left+right pair shares ONE page-break check before either cell is
// drawn, so the two columns can never end up split across different pages.
function poMeasurementGrid(doc, entries) {
  const items = entries.filter(([, value]) => value);
  if (!items.length) return false;
  const fullWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const gap = 24;
  const colWidth = (fullWidth - gap) / 2;
  const half = Math.ceil(items.length / 2);
  const left = items.slice(0, half);
  const right = items.slice(half);
  for (let i = 0; i < left.length; i++) {
    const leftDisplay = String(left[i][1]);
    const leftH = poRowHeight(doc, left[i][0], leftDisplay, colWidth);
    let pairH = leftH;
    let rightDisplay = null;
    if (right[i]) {
      rightDisplay = String(right[i][1]);
      pairH = Math.max(leftH, poRowHeight(doc, right[i][0], rightDisplay, colWidth));
    }
    if (doc.y + pairH + 5 > doc.page.height - doc.page.margins.bottom) doc.addPage();
    // Both cells read doc.y once at their own start (inside poRowAt) and
    // never depend on it being unchanged from the other cell's call, so
    // drawing left then right here — with no doc.y write between them —
    // still places both at the same row.
    const rowBottomLeft = poRowAt(doc, left[i][0], leftDisplay, doc.page.margins.left, colWidth, pairH);
    const rowBottomRight = right[i]
      ? poRowAt(doc, right[i][0], rightDisplay, doc.page.margins.left + colWidth + gap, colWidth, pairH)
      : rowBottomLeft;
    doc.y = Math.max(rowBottomLeft, rowBottomRight);
  }
  return true;
}

// Replicates the production workshop's own paper order docket (see the
// scanned template Luc shared), styled like the branded client emails
// (same palette/eyebrow-and-rule pattern as lib/emailTemplate.js) instead of
// a generic gray PDFKit default — a clear label/value table per section
// rather than a wall of "标签 Label: value" prose. Built from finalConfig
// (order.config_json, set by sly-suit-meeting's buildFinalConfig at finalize
// time), not from configSummary, since it needs raw per-field values rather
// than pre-joined display strings. Sent to Luc for review, never straight to
// the workshop — he forwards it himself once he's checked it.
export function buildProductionOrderPdf({ order, client, config, shopConfigSummary }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: 'A4' });
    doc.registerFont('CJK', NOTO_SANS_SC_PATH);
    doc.font('CJK'); // single weight available — hierarchy comes from color/size, not bold
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const fullWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const pageRight = doc.page.width - doc.page.margins.right;
    const rule = (color = PO_PALETTE.border) => {
      doc.moveTo(doc.page.margins.left, doc.y).lineTo(pageRight, doc.y).strokeColor(color).lineWidth(1).stroke();
      doc.moveDown(0.8);
    };

    const bodyMeasurements = config?.bodyMeasurements || {};
    const finalJacket = config?.finalJacket || {};
    const finalPant = config?.finalPant || {};
    const trousers = config?.trousers || {};
    const jacket = config?.jacket || {};

    // Wordmark header — same letter-spaced "SLY / ATELIER" treatment as the
    // branded email, just without the serif webfont (only one CJK-capable
    // weight is embedded here).
    doc.fontSize(22).fillColor(PO_PALETTE.ink).text('SLY', { characterSpacing: 3 });
    doc.fontSize(8).fillColor(PO_PALETTE.muted).text('ATELIER', { characterSpacing: 3 });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor(PO_PALETTE.cherry).text('生产订单 · PRODUCTION ORDER', { characterSpacing: 0.8 });
    doc.fontSize(8).fillColor(PO_PALETTE.muted)
      .text('À vérifier avant envoi à l\'atelier — Please review before sending to the workshop');
    doc.moveDown(0.8);
    rule();

    const fullName = `${client?.first_name || ''} ${client?.last_name || ''}`.trim() || '—';
    poRow(doc, 'CUSTOMER 客户', fullName, { force: true });
    poRow(doc, '单号 ORDER NO.', order.order_number || order.id, { force: true });
    poRow(doc, 'TEL 电话', client?.phone, { force: true });
    // The workshop ships directly to the client — this is the shipping
    // destination, not Luc's own address. Force-shown (not skipped when
    // empty) because a missing delivery address is exactly the kind of gap
    // that needs to be visible before this goes out, not silently hidden.
    poRow(doc, '地址 DELIVERY ADDRESS 收货地址', client?.address, { force: true });
    poRow(doc, '经手人 HANDLED BY', config?.stylistName);
    doc.moveDown(0.2);

    if (config?.workshopDeadline) {
      const bandY = doc.y;
      const bandH = 24;
      doc.rect(doc.page.margins.left, bandY, fullWidth, bandH).fill(PO_PALETTE.cherry);
      doc.fillColor(PO_PALETTE.white).fontSize(9.5)
        .text(`DATE LIMITE / DEADLINE 交货期限 : ${config.workshopDeadline}`, doc.page.margins.left + 12, bandY + 6);
      doc.y = bandY + bandH + 12;
    }

    // What the client originally picked on the website configurator, before
    // the in-person meeting — kept separate from the fields below (which
    // reflect the stylist's final, in-meeting configuration) because
    // sly-shop's option set doesn't map field-for-field onto this tool's own
    // config. Shown as-is for reference/cross-check — absent entirely for
    // orders taken fully in person with no prior website configuration.
    if (Array.isArray(shopConfigSummary) && shopConfigSummary.length) {
      poSectionTitle(doc, '网站客户初选', "CLIENT'S WEBSITE SELECTION (pre-meeting, cross-check only)");
      for (const [label, value] of shopConfigSummary) {
        if (value == null || value === '' || value === '—') continue;
        if (/prix|price|acompte|deposit/i.test(label)) continue; // same reason pricing was stripped elsewhere
        poRow(doc, label, value);
      }
    }

    const piece = [config?.jacket ? 'Blazer/Veste' : null, trousers && Object.keys(trousers).length ? 'Pantalon' : null]
      .filter(Boolean).join(' + ') || config?.productType || '—';
    poSectionTitle(doc, '面料', 'FABRIC');
    poRow(doc, '部位 Piece', piece, { force: true });
    poRow(doc, '面料 Fabric', config?.fabricName);
    poRow(doc, '面料参考 Fabric ref', config?.fabricReference);
    if (config?.fabricIsCustom) poRow(doc, '备注 Note', 'PERSONNALISÉ — hors bibliothèque / CUSTOM', { force: true });

    // Construction/style choices, one field per row instead of packed
    // "A: x · B: y" lines — easier to scan, and nothing is skipped because
    // it happened to share a line with something else.
    if (config?.jacket && Object.values(jacket).some(Boolean)) {
      poSectionTitle(doc, '款式 — 上身', 'JACKET STYLE');
      poRow(doc, '风格 Style', jacket.silhouette);
      poRow(doc, '剪裁 Cut', jacket.cut);
      poRow(doc, '门襟 Breasted', jacket.breasted);
      poRow(doc, '纽扣 Buttons', jacket.buttons);
      poRow(doc, '翻领款式 Lapel type', jacket.lapelType);
      const lapelWidthHint = jacket.lapelWidth && LAPEL_WIDTH_CM[jacket.lapelWidth]
        ? `${jacket.lapelWidth} (${LAPEL_WIDTH_CM[jacket.lapelWidth]})` : jacket.lapelWidth;
      poRow(doc, '翻领宽度 Lapel width', lapelWidthHint);
      poRow(doc, '口袋 Pockets', jacket.pocketStyle);
      poRow(doc, '开衩 Vents', jacket.ventStyle);
      // liningType is the current (post-2026-08-14) field — orders taken
      // before that only have the old free-text `lining` field, which often
      // carries an actual supplier reference (e.g. "A710") rather than a
      // full/half/none category. Shown either way rather than silently
      // dropped when liningType is absent.
      poRow(doc, '里布 Lining', jacket.liningType);
      if (!jacket.liningType) poRow(doc, '里布（旧格式）Lining (legacy)', jacket.lining);
      poRow(doc, '纽扣材质 Buttons material', jacket.buttonsMaterial);
      // The atelier's actual reference codes — the whole point of this
      // section for the workshop, previously missing from the jacket block
      // entirely even though the fields exist on JacketConfig (trousers had
      // its own buttonReference row, jacket never did).
      poRow(doc, '面料参考 Fabric ref', jacket.fabricReference);
      poRow(doc, '里布参考 Lining ref', jacket.liningReference);
      poRow(doc, '纽扣参考 Button ref', jacket.buttonReference);
      poRow(doc, '绣字/姓名缩写 Monogram/Initials', jacket.monogram);
      if (jacket.monogram) {
        // 2026-08-22: real per-order fields (Luc's standardized order form)
        // replaced the earlier fixed atelier-convention guess — falls back
        // to that guess only for orders where these weren't captured yet.
        poRow(doc, '绣字位置 Position', jacket.monogramPosition || '衣领下方，后颈处 / Under the collar, at the nape', { force: true });
        poRow(doc, '绣字颜色 Thread color', jacket.monogramColor || '金色 / Gold', { force: true });
      }
    }

    if (trousers && Object.values(trousers).some(Boolean)) {
      poSectionTitle(doc, '款式 — 裤子', 'TROUSER STYLE');
      poRow(doc, '剪裁 Cut', trousers.cut);
      poRow(doc, '褶裥 Pleats', trousers.pleats);
      poRow(doc, '脚口 Cuff', trousers.cuff);
      poRow(doc, '腰位 Rise', trousers.rise);
      poRow(doc, '腰头 Waistband', trousers.waistband);
      poRow(doc, '调节 Adjusters', trousers.sideAdjustersOrBeltLoops);
      poRow(doc, '腰头宽度 Waistband width', trousers.waistbandWidthCm ? `${trousers.waistbandWidthCm} cm` : null);
      poRow(doc, '纽扣参考 Button ref', trousers.buttonReference);
      poRow(doc, '里布 Lining', trousers.lining);
    }

    // What the client asked for, in their own words where available —
    // occasion/criteria notes from the meeting (no budget/price — the
    // workshop doesn't need that), not just the technical spec above.
    const occasion = config?.occasion || {};
    const criteria = config?.criteria || {};
    const colorPatternNotes = [criteria.clientColorNotes, criteria.clientPatternNotes].filter(Boolean).join(' · ');
    if (occasion.category || occasion.clientAnswerNotes || colorPatternNotes) {
      poSectionTitle(doc, '客户期望风格', 'CLIENT STYLE EXPECTATIONS');
      poRow(doc, '场合 Occasion', occasion.category);
      poRow(doc, '客户需求 Client need', occasion.clientAnswerNotes);
      poRow(doc, '颜色/图案备注 Color/pattern', colorPatternNotes);
    }

    // 版型 fit preference — replaces the old body-check tick-boxes (removed
    // 2026-08-09), but orders taken before that only ever set it inside the
    // legacy bodyCheck object — fall back there rather than showing nothing
    // when the data actually exists, just under the old key.
    const fitPreference = config?.fitPreference || config?.bodyCheck?.fitPreference || null;
    // Body type checkboxes on Luc's standardized order form (体型) — re-added
    // 2026-08-22 as a plain multi-select (BodyTypeFlag), only ever a
    // best-effort note for the workshop to adjust the patronage, not
    // exhaustive body-check data the way the old removed 9-dropdown form was.
    const BODY_TYPE_LABELS = {
      'sloping-shoulders': '斜肩 Sloping shoulders',
      'forward-shoulders': '冲肩 Forward shoulders',
      'square-shoulders': '平肩 Square shoulders',
      'full-bust': '大胸 Full bust',
      'prominent-stomach': '大肚 Prominent stomach',
      'fleshy-shoulders': '肉肩 Fleshy shoulders',
      'fleshy-back': '肉背 Fleshy back',
      'hunched-back': '驼背 Hunched back',
      'hollow-waist': '凹腰 Hollow waist',
      'prominent-hips': '翘臀 Prominent hips',
    };
    const bodyTypeText = Array.isArray(config?.bodyTypeFlags)
      ? config.bodyTypeFlags.map((f) => BODY_TYPE_LABELS[f] || f).join(' · ')
      : '';
    if (fitPreference || config?.measurementApproach || bodyTypeText) {
      poSectionTitle(doc, '版型与量体方式', 'FIT & APPROACH');
      poRow(doc, '版型 Fit preference', fitPreference);
      poRow(doc, '量体方式 Measurement approach', config?.measurementApproach);
      poRow(doc, '体型 Body type', bodyTypeText);
    }

    const bodyEntries = BODY_MEASUREMENT_ROWS.map(([cn, en, get]) => [`${cn} ${en}`, get(bodyMeasurements)]);
    if (bodyEntries.some(([, v]) => v)) {
      poSectionTitle(doc, '原始体型尺寸', 'BODY MEASUREMENTS (cm)');
      poMeasurementGrid(doc, bodyEntries);
    }

    const jacketEntries = JACKET_MEASUREMENT_ROWS.map(([cn, en, get]) => [`${cn} ${en}`, get(finalJacket)]);
    if (config?.jacket && jacketEntries.some(([, v]) => v)) {
      poSectionTitle(doc, '尺寸 — 上身', 'FINAL JACKET MEASUREMENTS (cm)');
      poMeasurementGrid(doc, jacketEntries);
      if (finalJacket.comment) {
        doc.fontSize(9).fillColor(PO_PALETTE.cherry).text(`【注意 NOTE】 ${finalJacket.comment}`, { width: fullWidth });
        doc.moveDown(0.6);
      }
    }

    // Pleat/cuff are already shown in TROUSER STYLE above — only the actual
    // numeric measurements belong here, and only when at least one is
    // present (an order with trousers.pleats set but no finalPant data yet
    // used to still print this whole section as a wall of dashes, which
    // reads as "nothing was measured" when in fact it just hasn't been
    // entered into the new structured fields — see the legacy fallback
    // below for orders where the numbers exist under the old flat shape).
    const pantEntries = TROUSER_MEASUREMENT_ROWS.map(([cn, en, get]) => [`${cn} ${en}`, get(finalPant)]);
    if (pantEntries.some(([, v]) => v)) {
      poSectionTitle(doc, '尺寸 — 裤子', 'FINAL TROUSER MEASUREMENTS (cm)');
      poMeasurementGrid(doc, pantEntries);
      if (finalPant.comment) {
        doc.fontSize(9).fillColor(PO_PALETTE.cherry).text(`【注意 NOTE】 ${finalPant.comment}`, { width: fullWidth });
        doc.moveDown(0.6);
      }
    }

    // Orders finalized before 2026-08-09 used a flat measurements/bodyCheck
    // shape with no equivalent to bodyMeasurements/finalJacket/finalPant —
    // without this fallback, those orders' measurements section above is
    // entirely skipped and the workshop gets a PDF with no numbers at all.
    const hasNewMeasurements = bodyEntries.some(([, v]) => v) || jacketEntries.some(([, v]) => v) || pantEntries.some(([, v]) => v);
    if (!hasNewMeasurements && config?.measurements && typeof config.measurements === 'object') {
      const legacyEntries = Object.entries(config.measurements);
      if (legacyEntries.some(([, v]) => v)) {
        poSectionTitle(doc, '尺寸（旧格式）', 'MEASUREMENTS (legacy format, cm)');
        poMeasurementGrid(doc, legacyEntries);
      }
    }
    if (config?.bodyCheck && typeof config.bodyCheck === 'object') {
      // fitPreference is already shown under FIT & APPROACH above (via the
      // fallback added there) — excluded here so it isn't printed twice.
      const bodyCheckEntries = Object.entries(config.bodyCheck).filter(([k]) => k !== 'fitPreference');
      if (bodyCheckEntries.some(([, v]) => v)) {
        poSectionTitle(doc, '体型检查（旧格式）', 'BODY CHECK (legacy format)');
        poMeasurementGrid(doc, bodyCheckEntries);
      }
    }

    if (config?.generalNotes) {
      poSectionTitle(doc, '备注', 'NOTES');
      doc.fontSize(9.5).fillColor(PO_PALETTE.ink).text(config.generalNotes, { width: fullWidth });
      doc.moveDown(0.6);
    }

    doc.moveDown(0.4);
    rule();
    const orderDate = order.created_at ? String(order.created_at).slice(0, 10) : '______ / ______ / ______';
    const fittingDate = config?.fittingDate || '______ / ______ / ______';
    const pickupDate = config?.pickupDate || '______ / ______ / ______';
    doc.fontSize(8.5).fillColor(PO_PALETTE.muted)
      .text(`订单日期 Order date: ${orderDate}      试样日期 Fitting date: ${fittingDate}      取货日期 Pickup date: ${pickupDate}`);

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
