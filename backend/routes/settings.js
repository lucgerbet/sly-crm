import { Router } from 'express';
import db from '../db.js';

const router = Router();

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  ['revenue_target','avg_basket_target','daily_target','weekly_target','birthday_reminder_days_before'].forEach(k => {
    if (out[k] != null) out[k] = Number(out[k]);
  });
  out.automation_enabled = out.automation_enabled === '1' || out.automation_enabled === 1;
  return out;
}

router.get('/', (_req, res) => {
  res.json(getSettings());
});

router.put('/', (req, res) => {
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  const tx = db.transaction((obj) => {
    for (const [k, v] of Object.entries(obj)) {
      const stored = k === 'automation_enabled' ? (v ? '1' : '0') : String(v);
      stmt.run(k, stored);
    }
  });
  tx(req.body || {});
  res.json(getSettings());
});

export default router;
