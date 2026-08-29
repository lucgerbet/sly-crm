export const TIMING = {
  now:      { label: 'Now',      color: 'bg-red-100 text-red-700',       dot: '#E24B4A' },
  '1month': { label: '1 month',  color: 'bg-amber-100 text-amber-700',   dot: '#EF9F27' },
  '3months':{ label: '3 months', color: 'bg-blue-100 text-blue-700',     dot: '#378ADD' },
  '6months':{ label: '6 months', color: 'bg-violet-100 text-violet-700', dot: '#7F77DD' },
};

export const POTENTIAL = {
  high:   { label: 'High',   color: 'bg-green-100 text-green-800', dot: '#639922' },
  medium: { label: 'Medium', color: 'bg-amber-100 text-amber-700', dot: '#EF9F27' },
  low:    { label: 'Low',    color: 'bg-gray-100 text-gray-600',   dot: '#D3D1C7' },
};

// Sequential pipeline steps: each requires the previous one to be done first.
// Keep in sync with backend routes/clients.js STAGE_PREREQ.
export const STAGE_PREREQ = { answered: 'contacted', appointment: 'answered', won: 'appointment' };

export const STAGE_META = {
  contacted:   { label: 'Contacted', noteLabel: 'Message sent', messageType: 'outreach' },
  answered:    { label: 'Replied',   noteLabel: "Client's reply", messageType: 'reply' },
  appointment: { label: 'Meeting booked', noteLabel: 'Meeting details', messageType: 'appointment',
                 extraFields: [
                   { key: 'appointment_date', label: 'Date', type: 'date' },
                   { key: 'appointment_time', label: 'Time', type: 'time' },
                   { key: 'appointment_location', label: 'Location', type: 'text', placeholder: 'Where…' },
                 ] },
  won:         { label: 'Became a client', noteLabel: 'Sale amount', messageType: 'sale' },
};

export const MESSAGE_TYPES = {
  note:        { label: 'Note',          color: 'border-gray-200 bg-gray-50',   text: 'text-gray-500'   },
  outreach:    { label: 'Outreach',      color: 'border-blue-200 bg-blue-50',   text: 'text-blue-700'   },
  reply:       { label: 'Client reply',  color: 'border-green-200 bg-green-50', text: 'text-green-700'  },
  appointment: { label: 'Meeting',       color: 'border-orange-200 bg-orange-50', text: 'text-orange-700' },
  sale:        { label: 'Sale',          color: 'border-violet-200 bg-violet-50', text: 'text-violet-700' },
  birthday_reminder: { label: 'Birthday reminder (auto)', color: 'border-pink-200 bg-pink-50', text: 'text-pink-700' },
  birthday_greeting: { label: 'Birthday greeting (auto)', color: 'border-pink-200 bg-pink-50', text: 'text-pink-700' },
  call_transcript: { label: 'Call recap (Fathom)', color: 'border-teal-200 bg-teal-50', text: 'text-teal-700' },
  // Written by the backend (see logMessage calls). Without an entry here they
  // all fell back to the grey "Note" style, which made the order emails
  // impossible to pick out of an activity log.
  order_intake:        { label: 'Order placed',        color: 'border-violet-200 bg-violet-50', text: 'text-violet-700' },
  deposit_paid:        { label: 'Deposit paid',        color: 'border-green-200 bg-green-50',   text: 'text-green-700'  },
  order_finalized:     { label: 'Recap email sent',    color: 'border-blue-200 bg-blue-50',     text: 'text-blue-700'   },
  balance_paid:        { label: 'Balance paid',        color: 'border-green-200 bg-green-50',   text: 'text-green-800'  },
  appointment_reminder:{ label: 'Meeting reminder (auto)', color: 'border-orange-200 bg-orange-50', text: 'text-orange-700' },
};

// Compute effective timing bucket from a target contact date (mirrors backend)
export function effectiveTiming(targetDate) {
  if (!targetDate) return null;
  const days = daysUntil(targetDate);
  if (days <= 0) return 'now';
  if (days <= 31) return '1month';
  if (days <= 92) return '3months';
  return '6months';
}

export function daysUntil(dateStr) {
  if (!dateStr) return null;
  const target = new Date(dateStr);
  const now = new Date();
  return Math.ceil((target - now) / 86400000);
}

export function todayPlusMonths(n) {
  const d = new Date();
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Lifetime-value tiers — generic thresholds for a brand starting from zero.
// Keep ranges in sync with backend routes/clients.js VALUE_TIER_SQL.
// contact_type is computed server-side (routes/clients.js CONTACT_TYPE) —
// 'client' = at least one paid-deposit order, full stop. 'prospect_physical'
// is a manual flag (email collected in person, hand-entered by Luc);
// 'prospect_online' is the default for anyone who only ever gave an email
// through the website (lead capture or an unpaid checkout).
export const CONTACT_TYPE_OPTS = [
  ['', 'All categories'],
  ['prospect_online', 'Prospect'],
  ['prospect_physical', 'Prospect (physique)'],
  ['client', 'Client'],
];
export const CONTACT_TYPE_BADGE = {
  client: { label: 'Client', color: 'bg-green-100 text-green-800' },
  prospect_physical: { label: 'Prospect physique', color: 'bg-amber-100 text-amber-700' },
  prospect_online: { label: 'Prospect', color: 'bg-gray-100 text-gray-600' },
};

export const VALUE_TIERS = {
  platinum: { label: 'Platinum', min: 5000, color: 'bg-slate-200 text-slate-700',   dot: '#64748B' },
  gold:     { label: 'Gold',     min: 2000, color: 'bg-amber-100 text-amber-800',   dot: '#D69E2E' },
  silver:   { label: 'Silver',   min: 500,  color: 'bg-gray-100 text-gray-600',     dot: '#9CA3AF' },
  bronze:   { label: 'Bronze',   min: 0,    color: 'bg-orange-100 text-orange-800', dot: '#C2703D' },
};
export function valueTier(ca) {
  const v = Number(ca) || 0;
  if (v >= 5000) return 'platinum';
  if (v >= 2000) return 'gold';
  if (v >= 500)  return 'silver';
  return 'bronze';
}

export function monthsSince(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return Math.max(0, Math.round((Date.now() - d.getTime()) / (30.44 * 86400000)));
}

export function fmtDate(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return d; }
}

export function fmtMoney(n, currency = '€') {
  if (n == null || n === '' || Number(n) === 0) return '—';
  return `${currency} ${Number(n).toLocaleString('en-US')}`;
}

export function fmtMoneyShort(n, currency = '€') {
  const v = Number(n) || 0;
  if (v >= 1000) return `${currency} ${(v / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k`;
  return `${currency} ${v.toLocaleString('en-US')}`;
}

export function initials(first, last) {
  return [(first || '').charAt(0), (last || '').charAt(0)].join('').toUpperCase() || '?';
}

// Same field keys as sly-crm/backend/lib/pdf.js's BODY_MEASUREMENT_ROWS /
// JACKET_MEASUREMENT_ROWS / TROUSER_MEASUREMENT_ROWS (EN labels only —
// this admin UI is English-labeled, unlike the bilingual CN/EN workshop PDF).
export const BODY_MEASUREMENT_LABELS = {
  shoulder: 'Shoulder', chest: 'Chest', waistJacket: 'Waist (jacket)', stomach: 'Stomach',
  hips: 'Hips', biceps: 'Biceps', forearm: 'Forearm', wrist: 'Wrist', armHole: 'Armhole',
  neck: 'Neck', waistPant: 'Waist (trousers)', sideNeckPointToUpperHips: 'Side neck to upper hip',
  thigh: 'Thigh', knee: 'Knee', calf: 'Calf', ankle: 'Ankle',
};

export const FINAL_JACKET_LABELS = {
  shoulder: 'Shoulder', sleeveLength: 'Sleeve', lengthFront: 'Length (front)', lengthBack: 'Length (back)',
  chest: 'Bust', waist: 'Waist', stomach: 'Stomach', hips: 'Hips',
  armWidth: 'Arm width', armHole: 'Arm hole', sleeveOpening: 'Sleeve opening',
};

export const FINAL_PANT_LABELS = {
  length: 'Length', waist: 'Waist', hip: 'Hip', thigh: 'Thigh', knee: 'Knee',
  wholeCrotch: 'Whole crotch', calf: 'Calf', cuffOpening: 'Cuff opening',
};
