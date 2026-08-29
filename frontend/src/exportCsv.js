import { TIMING, POTENTIAL } from './labels.js';

const COLS = [
  ['First name',       c => c.first_name],
  ['Last name',        c => c.last_name],
  ['City',             c => c.city],
  ['Country',          c => c.country],
  ['Phone',            c => c.phone],
  ['Email',            c => c.email],
  ['Source',           c => c.source],
  ['Tags',             c => c.tags],
  ['Lifetime revenue', c => c.lifetime_value ?? c.ca_lifetime],
  ['Paid orders', c => c.order_count ?? ''],
  ['Orders',           c => c.purchase_count],
  ['Last purchase',    c => c.last_purchase_date],
  ['Potential',        c => POTENTIAL[c.potential]?.label || ''],
  ['Timing',           c => TIMING[c.eff_timing]?.label || ''],
  ['Contacted',        c => c.contacted ? 'Yes' : ''],
  ['Replied',          c => c.answered ? 'Yes' : ''],
  ['Meeting',          c => c.appointment ? 'Yes' : ''],
  ['Client',           c => c.won ? 'Yes' : ''],
  ['Lost',             c => c.lost ? 'Yes' : ''],
  ['Assigned to',      c => c.assigned_to],
  ['Next step',        c => c.next_step],
  ['Last contacted',   c => c.last_contacted_date],
  ['Notes',            c => c.notes],
];

function esc(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function clientsToCsv(clients) {
  const header = COLS.map(c => c[0]).join(',');
  const rows = clients.map(c => COLS.map(([, f]) => esc(f(c))).join(','));
  return [header, ...rows].join('\n');
}

export function downloadCsv(clients) {
  const csv = clientsToCsv(clients);
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sly-crm-clients-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
