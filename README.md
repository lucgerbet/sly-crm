# SLY — CRM

A lightweight, single-user CRM to start collecting client/lead data for SLY. Built as a
simplified fork of the Atelier Fusari reactivation CRM's foundation, stripped of the
Fusari-specific reactivation workflow (Ben's qualification, WeChat reconnect, RMB) down to a
generic new-business pipeline: leads in, tracked through Contacted → Replied → Meeting → Client.

**Stack:** React (Vite) + TailwindCSS · Node/Express · SQLite (`better-sqlite3`).

## Setup

```bash
# 1. Backend (API on :3003)
cd backend && npm install && node index.js

# 2. Frontend (UI on :5175) — in a second terminal
cd frontend && npm install && npm run dev

# 3. Open http://localhost:5175
```

The SQLite database is created/seeded automatically on first boot of the backend — no manual
migration step. Default goal settings (revenue target, avg basket, daily/weekly targets) are
placeholders in the `settings` table — edit via `PUT /api/settings` or the Dashboard once real
numbers are known.

## Architecture

```
sly-crm/
├── backend/
│   ├── index.js            Express entry — migrate + seed on boot, mounts routes
│   ├── db.js                better-sqlite3 connection + schema migration
│   └── routes/
│       ├── clients.js       CRUD + activity log (messages) + sequential pipeline flags
│       ├── stats.js         dashboard stats
│       ├── tracker.js       "My Day" picks/overdue/upcoming
│       ├── reports.js       funnel + charts data
│       ├── settings.js      goal targets, currency, automation templates
│       ├── automation.js    birthday automation status / manual run / test email
│       ├── unsubscribe.js   public opt-out link (no Basic Auth — see Deploy)
│       ├── orders.js        order intake (from sly-shop) + finalize (from the order-taking tool)
│       ├── webhooks.js      Stripe checkout.session.completed handler (deposit + balance)
│       └── appointments.js  Calendly booking intake (from-widget) + 2h reminder status/run
│   └── lib/
│       ├── email.js         Resend HTTP wrapper + {{placeholder}} rendering + wrapHtml
│       ├── stripe.js        Payment Link creation + webhook signature verification
│       ├── orderHelpers.js  shared client find-or-create, money/date formatting, order numbers
│       ├── birthdayJob.js   finds birthday-reminder/-greeting candidates, sends, logs
│       └── appointmentReminderJob.js  finds appointments ~2h out, sends, logs
└── frontend/
    └── src/
        ├── App.jsx           shell: header, tab nav, toasts, slide-over panel
        ├── api.js            fetch client
        ├── labels.js         shared enums/formatters (timing, potential, value tiers)
        └── components/
            ├── Dashboard.jsx   pipeline funnel, revenue goal gauge
            ├── Daily.jsx       "My Day": today's picks, overdue, upcoming
            ├── ClientList.jsx  search / filter / sort + inline stage toggles
            ├── ClientDetail.jsx profile / pipeline / activity tabs
            ├── Reports.jsx     funnel + donut + weekly charts, print-to-PDF
            └── Automation.jsx  birthday email settings, test send, run now, log
```

## Birthday email automation

Every client has an optional `birth_date` and an `email_opt_out` flag (Profile tab). A daily job
(cron, 08:00 Europe/Paris, also triggerable manually from the Automation tab) sends, via
[Resend](https://resend.com):

- a **reminder** email N days before the birthday (default 30, editable), with a link to
  `shop_url` — meant to prompt a self-gift purchase
- a **greeting** email on the birthday itself

Both are at most once per client per year (deduped against the client's activity log), skip
opted-out or lost clients, and always get an unsubscribe link appended (see `routes/unsubscribe.js`).
Templates (subject + body, with `{{first_name}}` / `{{last_name}}` / `{{shop_url}}` placeholders)
are editable from the Automation tab — no code change needed to update the wording.

**Not configured by default.** Until `RESEND_API_KEY` is set in the backend environment, the
Automation tab shows a warning and the "Enabled" toggle, test-send, and run-now actions stay
disabled — nothing is ever sent. To turn it on: create a [Resend](https://resend.com) account,
verify a sending domain (or use the sandbox `onboarding@resend.dev` address for testing — it only
delivers to your own inbox), get an API key, then set `RESEND_API_KEY` and `EMAIL_FROM` in
`/docker/sly-crm/.env` on the VPS (see `.env.example`) and redeploy. Finally flip "Enabled" on in
the Automation tab.

WhatsApp automation was intentionally left out for now — see the conversation this was built in
for the trade-offs (official WhatsApp Business API vs. unofficial/bannable automation).

## Order / appointment automation (sly-shop integration)

Connects the sly-shop configurator + Stripe deposit + Calendly booking flow to this CRM, so every
step of an order — appointment confirmation, a 2h-before reminder, CRM sync, order recap + balance
payment link, payment confirmation — happens automatically instead of relying on a customer's
browser tab staying open (see the `orders`/`appointments` tables and `routes/orders.js`,
`routes/webhooks.js`, `routes/appointments.js`).

Flow: sly-shop calls `POST /api/orders/intake` right after creating the Stripe deposit Checkout
session (before the customer pays) → the Stripe webhook (`POST /api/webhooks/stripe`) marks the
deposit paid → sly-shop's Calendly widget calls `POST /api/appointments/from-widget` once booked
(Calendly is on the free plan — no server-side webhooks available, so this postMessage-driven path
is the current integration; upgrading to a real Calendly webhook later needs zero schema changes,
just a new route) → the confirmation email sends → a cron job every 15 minutes finds appointments
~2h out and sends the reminder → once the (not-yet-built) order-taking tool calls
`POST /api/orders/finalize`, a Stripe Payment Link is created for the balance and the recap email
sends → paying that link fires the webhook again and sends the final payment confirmation.

All four new server-to-server routes (`/api/webhooks/*`, `/api/orders/intake`,
`/api/orders/finalize`, `/api/appointments/from-widget`) sit behind a public Traefik router (no
Basic Auth — these callers aren't human browser sessions) but each independently checks its own
secret: Stripe's webhook signature, or a shared `SLY_INTAKE_SECRET` bearer token for the rest. See
`.env.example` for the new variables required (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`SLY_INTAKE_SECRET`).

## Pipeline model

Each client moves through a simple sequential pipeline: `contacted` → `answered` (replied) →
`appointment` (meeting booked) → `won` (became a client). A lead can be marked `lost` (with a
reason) from any point. `target_contact_date` drives the "My Day" timing buckets (now / 1 month /
3 months / 6 months), same logic as the Atelier Fusari reactivation CRM this was forked from.

## Deploy

Same pattern as `af-crm` / `reactivation-crm`: multi-stage Docker build (frontend → static
`public/` served by the Express backend), deployed to the Hostinger VPS behind Traefik with a
dedicated Basic Auth credential (separate from the other two CRMs on purpose). See
`docker-compose.yml`. Redeploy via `rsync` to `/docker/sly-crm/` on the VPS, then
`docker compose up -d --build` (no git-pull wiring, same as the other two CRMs). Daily DB backup:
`deploy/backup-sly-crm.sh` (install via cron on the VPS, mirrors `backup-reactivation.sh`).

`docker-compose.yml` declares two Traefik routers on the same service: the normal one (Basic Auth,
everything) and a second, more specific one matching only `PathPrefix(/api/unsubscribe)` with no
auth middleware — Traefik picks the more specific router for matching requests, so the
unsubscribe link in emails works without prompting recipients for the CRM's login.
