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
import ordersRouter from './routes/orders.js';
import webhooksRouter from './routes/webhooks.js';
import appointmentsRouter from './routes/appointments.js';
import { runBirthdayAutomation } from './lib/birthdayJob.js';
import { runAppointmentReminderJob } from './lib/appointmentReminderJob.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

migrate();
console.log('[db] Migrations OK');

const app = express();
app.use(cors());

// Stripe webhook signature verification needs the RAW request body — must be
// parsed here, before the global JSON parser below, or verification fails
// 100% of the time. body-parser marks the request as already-parsed, so the
// express.json() call further down safely skips re-parsing this one path.
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));

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
// /api/orders/finalize and /api/appointments/from-widget are also public at
// the Traefik level but each individually re-checks SLY_INTAKE_SECRET in
// Express (see requireIntakeSecret in lib/orderHelpers.js) — Traefik only
// removes Basic Auth here, it is not the real security boundary.
app.use('/api/unsubscribe', unsubscribeRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/appointments', appointmentsRouter);

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

// Appointment reminders need much tighter granularity than a daily check —
// every 15 minutes, catching anything ~2h out (see appointmentReminderJob.js
// for the overlap-window rationale).
cron.schedule('*/15 * * * *', () => {
  runAppointmentReminderJob({})
    .then(r => { if (!r.skipped && r.reminders.length) console.log(`[appointment-reminder] ${r.reminders.length} sent`); })
    .catch(e => console.error('[appointment-reminder] failed', e));
}, { timezone: process.env.TZ || 'Europe/Paris' });
