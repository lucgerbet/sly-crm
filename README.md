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
│       └── settings.js      goal targets, currency
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
            └── Reports.jsx     funnel + donut + weekly charts, print-to-PDF
```

## Pipeline model

Each client moves through a simple sequential pipeline: `contacted` → `answered` (replied) →
`appointment` (meeting booked) → `won` (became a client). A lead can be marked `lost` (with a
reason) from any point. `target_contact_date` drives the "My Day" timing buckets (now / 1 month /
3 months / 6 months), same logic as the Atelier Fusari reactivation CRM this was forked from.

## Deploy

Same pattern as `af-crm` / `reactivation-crm`: multi-stage Docker build (frontend → static
`public/` served by the Express backend), deployed to the Hostinger VPS behind Traefik with the
`luc` Basic Auth credential. See `docker-compose.yml`. Redeploy via `rsync` to
`/docker/sly-crm/` on the VPS, then `docker compose up -d --build` (no git-pull wiring, same as
the other two CRMs). Daily DB backup: `deploy/backup-sly-crm.sh` (install via cron on the VPS,
mirrors `backup-reactivation.sh`).
