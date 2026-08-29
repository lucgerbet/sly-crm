// Auto-fills Luc's own standardized production order template (Excel,
// "Purchase Order V3" — he built and shared this as the target form,
// 2026-08-22) from a finalized order's config_json. Same trigger point and
// same input shape as buildProductionOrderPdf in pdf.js — this is the
// structured, fillable sibling of that document, not a replacement for it
// (the PDF stays useful as a quick human-readable recap).
//
// Cell coordinates below mirror Luc's template file exactly (same merges,
// same row/column layout) so this is a straight fill-in, not a redesign —
// he can compare the two side by side and they should look identical except
// for the data.
import ExcelJS from 'exceljs';

// ── Vocabulary formatters — the template asks for short human phrases
// ("Double breasted 4 buttons"), not raw field values ("double"/"4x2") ──

function titleCase(s) {
  if (!s) return '';
  return String(s).replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const BUTTONS_PHRASE = { '1': '1 button', '2': '2 buttons', '3': '3 buttons', '4x2': '4 buttons', '6x2': '6 buttons' };

function clothingStyle(jacket) {
  if (!jacket?.breasted && !jacket?.buttons) return '';
  const breasted = jacket.breasted === 'double' ? 'Double breasted' : jacket.breasted === 'single' ? 'Single breasted' : '';
  const buttons = BUTTONS_PHRASE[jacket.buttons] || (jacket.buttons ? `${jacket.buttons} buttons` : '');
  return [breasted, buttons].filter(Boolean).join(' ');
}

// Matches Luc's own dropdown list (sheet "Listes"): "8,5 cm" / "9,5 cm" /
// "11 cm" — comma decimal, same 3-way closed set the app already asks for.
const LAPEL_SIZE_CM = { slim: '8,5 cm', classic: '9,5 cm', wide: '11 cm' };

function waistbandStyle(trousers) {
  if (!trousers?.waistband) return '';
  if (trousers.waistband === 'standard') return 'Standard';
  const adjuster = trousers.sideAdjustersOrBeltLoops === 'belt-loops' ? 'belt loops'
    : trousers.sideAdjustersOrBeltLoops === 'both' ? 'side adjustment & belt loops'
      : 'side adjustment';
  return `Double ${adjuster}`;
}

const PLEATS_PHRASE = { 'flat-front': 'None', 'single-pleat': 'One', 'double-pleat': 'Two' };

function productLine(config) {
  const type = config?.productType;
  const pieces = config?.suitType === '3-piece' ? '3 P Suit' : config?.suitType === '2-piece' ? '2 P Suit' : null;
  if (pieces) return pieces;
  if (type === 'blazer') return 'Blazer (Jacket)';
  if (type === 'trousers') return 'Trouser';
  return type || '';
}

// ── Sheet builder ──

const THIN = { style: 'thin', color: { argb: 'FFCCCCCC' } };
const BORDER_ALL = { top: THIN, left: THIN, bottom: THIN, right: THIN };

export async function buildTailoringOrderXlsx({ order, client, config }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Bon de commande');

  const jacket = config?.jacket || {};
  const trousers = config?.trousers || {};
  const criteria = config?.criteria || {};
  const bodyMeasurements = config?.bodyMeasurements || {};
  const finalJacket = config?.finalJacket || {};
  const finalPant = config?.finalPant || {};

  ws.columns = [
    { width: 10 }, { width: 12 }, { width: 12 }, { width: 10 }, { width: 8 }, { width: 10 },
    { width: 4 }, { width: 22 }, { width: 3 }, { width: 22 }, { width: 3 }, { width: 12 },
  ];

  function merge(range) { ws.mergeCells(range); }
  function set(ref, value, opts = {}) {
    const c = ws.getCell(ref);
    c.value = value ?? '';
    c.font = { name: 'Arial', size: opts.size || 10, bold: !!opts.bold, color: opts.color ? { argb: opts.color } : undefined };
    c.alignment = { vertical: 'middle', horizontal: opts.align || 'left', wrapText: true };
    if (opts.border !== false) c.border = BORDER_ALL;
    if (opts.fill) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.fill } };
    return c;
  }

  // Header
  merge('A1:L1');
  set('A1', '制衣订单 TAILORING ORDER FORM', { size: 14, bold: true, border: false });
  ws.getRow(1).height = 22;

  merge('A2:B2'); set('A2', '客户 CUSTOMER', { bold: true, fill: 'FFF0F0F0' });
  merge('C2:F2'); set('C2', `${client?.first_name || ''} ${client?.last_name || ''}`.trim());
  merge('G2:H2'); set('G2', '单号 ORDER NO.', { bold: true, fill: 'FFF0F0F0' });
  merge('I2:L2'); set('I2', order?.order_number || order?.id || '');

  merge('A3:B3'); set('A3', '电话 TEL', { bold: true, fill: 'FFF0F0F0' });
  merge('C3:F3'); set('C3', client?.phone || '');
  merge('G3:L3'); set('G3', '注：下午取衣 (Take dress at the afternoon please)', { size: 8.5, border: false });

  const totalCents = (order?.deposit_amount_cents || 0) + (order?.balance_amount_cents || 0);
  merge('A4:B4'); set('A4', '合计金额 TOTAL', { bold: true, fill: 'FFF0F0F0' });
  merge('D4:E4'); set('D4', '已收定金 DEPOSIT', { bold: true, fill: 'FFF0F0F0' });
  merge('G4:I4'); set('G4', '尚欠金额 BALANCE', { bold: true, fill: 'FFF0F0F0' });
  set('C4', totalCents ? totalCents / 100 : '');
  set('F4', order?.deposit_amount_cents ? order.deposit_amount_cents / 100 : '');
  merge('J4:L4'); set('J4', order?.balance_amount_cents ? order.balance_amount_cents / 100 : '');

  merge('A5:F5'); set('A5', '订单明细 ORDER DETAILS', { bold: true, fill: 'FFF0F0F0' });
  merge('G5:H5'); set('G5', '体型 BODY TYPE', { bold: true, fill: 'FFF0F0F0' });
  merge('I5:L5'); set('I5', '尺寸 MEASUREMENTS (cm)', { bold: true, fill: 'FFF0F0F0' });

  // Order details table header
  set('A6', '序号 NO.', { bold: true, size: 8.5 });
  set('B6', '品名 ARTICLE', { bold: true, size: 8.5 });
  set('C6', '面料 FABRIC', { bold: true, size: 8.5 });
  set('D6', '颜色 COLOR', { bold: true, size: 8.5 });
  set('E6', '数量 QUANTITY', { bold: true, size: 8.5 });
  set('F6', '金额 AMOUNT', { bold: true, size: 8.5 });

  // The 4 fixed material lines, pulled from the exact reference fields the
  // workshop needs — see pdf.js's own jacket/trousers reference rendering,
  // added the same session this template was shared for the same reason.
  const fabricRef = jacket.fabricReference || config?.fabricReference || '';
  const liningRef = jacket.liningReference || jacket.lining || trousers.lining || '';
  const jacketButtonRef = jacket.buttonReference || jacket.buttonsMaterial || '';
  const trouserButtonRef = trousers.buttonReference || jacketButtonRef;
  const fabricColor = criteria.colorFamilies?.[0] ? titleCase(criteria.colorFamilies[0]) : '';

  const materialRows = [
    ['Textile', fabricRef, fabricColor],
    ['Lining', liningRef, ''],
    ['Jacket Button', jacketButtonRef, ''],
    ['Trouser Button', trouserButtonRef, ''],
  ];
  for (let i = 0; i < 10; i++) {
    const row = 7 + i;
    set(`A${row}`, i + 1, { size: 9 });
    const m = materialRows[i];
    set(`B${row}`, m ? m[0] : '', { size: 9 });
    set(`C${row}`, m ? m[1] : '', { size: 9 });
    set(`D${row}`, m ? m[2] : '', { size: 9 });
    set(`E${row}`, '', { size: 9 });
    set(`F${row}`, '', { size: 9 });
  }
  // Body type — not captured anywhere in the meeting tool yet (the old
  // 9-field "body check" was deliberately removed in the 2026-08-09
  // measurements rebuild); re-added 2026-08-22 as a plain multi-select
  // (BodyTypeFlag in sly-suit-meeting/src/types.ts) — order here must match
  // that type's row order exactly, since a flag is just its array index.
  const BODY_TYPES = [
    ['sloping-shoulders', '斜肩 Sloping Shoulders'],
    ['forward-shoulders', '冲肩 Forward Shoulders'],
    ['square-shoulders', '平肩 Square Shoulders'],
    ['full-bust', '大胸 Full Bust'],
    ['prominent-stomach', '大肚 Prominent Stomach'],
    ['fleshy-shoulders', '肉肩 Fleshy Shoulders'],
    ['fleshy-back', '肉背 Fleshy Back'],
    ['hunched-back', '驼背 Hunched Back'],
    ['hollow-waist', '凹腰 Hollow Waist'],
    ['prominent-hips', '翘臀 Prominent Hips'],
  ];
  const bodyTypeFlags = new Set(config?.bodyTypeFlags || []);
  for (let i = 0; i < BODY_TYPES.length; i++) {
    const row = 6 + i;
    const [flag, label] = BODY_TYPES[i];
    set(`G${row}`, bodyTypeFlags.has(flag) ? '☑' : '☐', { align: 'center' });
    set(`H${row}`, label, { size: 8.5 });
  }

  // Measurements — left pair pulls from raw body measurements, right pair
  // mixes body (thigh/knee/calf/ankle) with final-garment lengths, matching
  // Luc's own template layout exactly rather than the app's own
  // body/final-jacket/final-pant split.
  const MEAS_LEFT = [
    ['肩宽 Shoulder', bodyMeasurements.shoulder],
    ['胸围 Chest', bodyMeasurements.chest],
    ['上衣腰围 Waist (Jacket)', bodyMeasurements.waistJacket],
    ['中腰 Stomach', bodyMeasurements.stomach],
    ['臀围 Hips', bodyMeasurements.hips],
    ['臂围 Biceps', bodyMeasurements.biceps],
    ['前臂围 Forearm', bodyMeasurements.forearm],
    ['袖窿深 Breast Height', ''], // no surviving source field — see JACKET_MEASUREMENT_ROWS note in pdf.js
    ['袖窿 Arm Hole', bodyMeasurements.armHole],
    ['领围 Neck', bodyMeasurements.neck],
    ['裤腰围 Waist (Pants)', bodyMeasurements.waistPant],
    ['侧颈点至上臀 Side Neck to Upper Hips', bodyMeasurements.sideNeckPointToUpperHips],
  ];
  const MEAS_RIGHT = [
    ['横裆 Thigh', bodyMeasurements.thigh],
    ['膝围 Knee', bodyMeasurements.knee],
    ['小腿围 Calf', bodyMeasurements.calf],
    ['脚踝围 Ankle', bodyMeasurements.ankle],
    ['袖长 Sleeve Length', finalJacket.sleeveLength],
    ['上衣长 Jacket Length', finalJacket.lengthFront],
    ['裤长 Trouser Length', finalPant.length],
    ['前后裆总长 Whole Crotch Length', finalPant.wholeCrotch],
  ];
  for (let i = 0; i < MEAS_LEFT.length; i++) {
    const row = 6 + i;
    set(`I${row}`, MEAS_LEFT[i][0], { size: 8.5 });
    set(`J${row}`, MEAS_LEFT[i][1] || '', { align: 'center' });
  }
  for (let i = 0; i < MEAS_RIGHT.length; i++) {
    const row = 6 + i;
    set(`K${row}`, MEAS_RIGHT[i][0], { size: 8.5 });
    set(`L${row}`, MEAS_RIGHT[i][1] || '', { align: 'center' });
  }
  // Dates fill the remaining right-column rows, same as Luc's template.
  set('K16', '订单日期 ORDER DATE', { size: 8.5 });
  set('L16', order?.created_at ? String(order.created_at).slice(0, 10) : '', { align: 'center' });
  set('K17', '试样日期 FITTING DATE', { size: 8.5 });
  set('L17', config?.fittingDate || '', { align: 'center' });
  set('K18', '取货日期 PICK-UP DATE', { size: 8.5 });
  set('L18', config?.pickupDate || '', { align: 'center' });

  merge('A18:E18'); set('A18', '合计 TOTAL', { bold: true, align: 'right' });
  set('F18', totalCents ? totalCents / 100 : '', { align: 'center' });

  merge('A19:L19'); set('A19', '客户资料 CLIENT PROFILE', { bold: true, fill: 'FFF0F0F0' });
  const mp = config || {};
  const [jacketSize, trouserSize] = String(config?.standardSizeReference || '').split('/').map((s) => s.trim());
  merge('A20:B20'); set('A20', '体重 Weight (kg)', { bold: true, size: 9 });
  set('C20', config?.weightKg || '', { align: 'center' });
  merge('D20:E20'); set('D20', '身高 Height (cm)', { bold: true, size: 9 });
  set('F20', config?.heightCm || '', { align: 'center' });
  merge('G20:H20'); set('G20', '上衣尺码 Standard Jacket Size', { bold: true, size: 9 });
  set('I20', jacketSize || config?.standardSizeReference || '', { align: 'center' });
  merge('J20:K20'); set('J20', '裤子尺码 Standard Trouser Size', { bold: true, size: 9 });
  set('L20', trouserSize || '', { align: 'center' });

  merge('A21:L21'); set('A21', '选项 GARMENT OPTIONS', { bold: true, fill: 'FFF0F0F0' });

  const OPTIONS_LEFT = [
    ['1 - 产品 Product', productLine(config)],
    ['2 - 面料颜色 Fabric Color', fabricColor],
    ['3 - 面料图案 Fabric Pattern', titleCase(criteria.pattern)],
    ['4 - 上衣款式 Jacket Style', titleCase(jacket.silhouette)],
    ['5 - 上衣剪裁 Jacket Cut', titleCase(jacket.cut)],
    ['6 - 门襟纽扣 Clothing Style', clothingStyle(jacket)],
    ['7 - 里布 Lining Style', titleCase(jacket.liningType)],
    ['8a - 驳头款式 Lapel Style', titleCase(jacket.lapelType)],
    ['8b - 驳头宽度 Lapel Size', LAPEL_SIZE_CM[jacket.lapelWidth] || ''],
    ['9 - 刺绣字母 Monogram / Initials', jacket.monogram || ''],
  ];
  const OPTIONS_RIGHT = [
    ['10 - 刺绣颜色 Monogram Color', titleCase(jacket.monogramColor)],
    ['11 - 刺绣位置 Monogram Positioning', jacket.monogramPosition || ''],
    ['12 - 裤子剪裁 Trouser Cut Style', titleCase(trousers.cut)],
    ['13 - 腰头款式 Waistband Style', waistbandStyle(trousers)],
    ['14 - 腰头宽度 Waistband Size', trousers.waistbandWidthCm ? `${trousers.waistbandWidthCm} cm` : ''],
    ['15 - 褶裥 Pleats', PLEATS_PHRASE[trousers.pleats] || ''],
    ['16 - 翻边 Cuff', trousers.cuff === 'cuff' ? 'Yes' : trousers.cuff === 'no-cuff' ? 'No' : ''],
  ];
  for (let i = 0; i < OPTIONS_LEFT.length; i++) {
    const row = 22 + i;
    merge(`A${row}:B${row}`); set(`A${row}`, OPTIONS_LEFT[i][0], { size: 9 });
    merge(`C${row}:F${row}`); set(`C${row}`, OPTIONS_LEFT[i][1], { size: 9 });
  }
  for (let i = 0; i < OPTIONS_RIGHT.length; i++) {
    const row = 22 + i;
    merge(`G${row}:I${row}`); set(`G${row}`, OPTIONS_RIGHT[i][0], { size: 9 });
    merge(`J${row}:L${row}`); set(`J${row}`, OPTIONS_RIGHT[i][1], { size: 9 });
  }

  const specificReq = [config?.workshopDeadline ? `Deadline: ${config.workshopDeadline}` : null, config?.productionNotes]
    .filter(Boolean).join(' — ');
  merge('A33:L33'); set('A33', '* 特殊要求 SPECIFIC REQUIREMENT', { bold: true, fill: 'FFF0F0F0' });
  merge('A34:L36'); set('A34', specificReq, { align: 'left' });

  const stylistNote = [finalJacket.comment, finalPant.comment].filter(Boolean).join(' / ');
  merge('A37:L37'); set('A37', '** 造型师备注 STYLIST NOTE', { bold: true, fill: 'FFF0F0F0' });
  merge('A38:L40'); set('A38', stylistNote, { align: 'left' });

  merge('A41:L41'); set('A41', '备注 REMARKS', { bold: true, fill: 'FFF0F0F0' });
  merge('A42:L42'); set('A42', config?.generalNotes || '', { align: 'left' });

  merge('A43:F43');
  set('A43', '注意：凭单取货，遗失即报我店。', { size: 8, border: false });
  merge('G43:L43'); set('G43', '经手人 Handled by:', { size: 8, border: false });
  merge('A44:F44');
  set('A44', 'Notice: Voucher to take dress. If bill lost, please at once tell our shop.', { size: 8, border: false });
  merge('G44:L44'); set('G44', '营业时间 Business hours: 9:00 - 18:00', { size: 8, border: false });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
