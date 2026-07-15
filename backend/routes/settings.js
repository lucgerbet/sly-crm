import { Router } from 'express';
import db from '../db.js';

const router = Router();

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  ['revenue_target','avg_basket_target','daily_target','weekly_target'].forEach(k => {
    if (out[k] != null) out[k] = Number(out[k]);
  });
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
    for (const [k, v] of Object.entries(obj)) stmt.run(k, String(v));
  });
  tx(req.body || {});
  res.json(getSettings());
});

export default router;
