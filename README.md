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
│       └── unsubscribe.js   public opt-out link (no Basic Auth — see Deploy)
│   └── lib/
│       ├── email.js         Resend HTTP wrapper + {{placeholder}} rendering
│       └── birthdayJob.js   finds birthday-reminder/-greeting candidates, sends, logs
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
