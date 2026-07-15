import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cron from 'node-cron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { migrate } from './db.js';
import clientsRouter from './routes/clients.js';
import statsRouter from './routes/stats.js';
import settingsRouter from './routes/settings.js';
import trackerRouter from './routes/tracker.js';
import reportsRouter from './routes/reports.js';
import automationRouter from './routes/automation.js';
import unsubscribeRouter from './routes/unsubscribe.js';
import { runBirthdayAutomation } from './lib/birthdayJob.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

migrate();
console.log('[db] Migrations OK');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'sly-crm' });
});

app.patch('/api/clients/:id', (req, res, next) => {
  req.method = 'PUT';
  clientsRouter.handle(req, res, next);
});

app.use('/api/clients', clientsRouter);
app.use('/api', statsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/tracker', trackerRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/automation', automationRouter);
// Public — no Basic Auth (see the dedicated Traefik router in docker-compose.yml).
app.use('/api/unsubscribe', unsubscribeRouter);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

const distPath = path.resolve(__dirname, process.env.FRONTEND_DIST || '../frontend/dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
}

app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Internal server error', detail: err.message });
});

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => {
  console.log(`\n  SLY — CRM → http://localhost:${PORT}\n`);
});

// Daily birthday-email check. runBirthdayAutomation() is itself a no-op unless
// RESEND_API_KEY is set and automation is turned on in Settings, so this is
// safe to leave scheduled even before either is configured.
cron.schedule('0 8 * * *', () => {
  runBirthdayAutomation({ baseUrl: process.env.PUBLIC_URL })
    .then(r => { if (!r.skipped) console.log(`[birthday-automation] ${r.reminders.length} reminders, ${r.greetings.length} greetings`); })
    .catch(e => console.error('[birthday-automation] failed', e));
}, { timezone: process.env.TZ || 'Europe/Paris' });
