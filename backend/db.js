import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATABASE_PATH
  ? path.resolve(__dirname, process.env.DATABASE_PATH)
  : path.resolve(__dirname, './sly_crm.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,

      -- Identity
      first_name TEXT,
      last_name TEXT,
      phone TEXT,
      email TEXT,
      city TEXT,
      country TEXT,
      source TEXT,
      tags TEXT,
      notes TEXT,
      birth_date TEXT,
      email_opt_out INTEGER DEFAULT 0,

      -- Follow-up (lightweight, always-visible)
      next_step TEXT,
      last_contacted_date TEXT,
      target_contact_date TEXT,

      -- Commercial value
      ca_lifetime REAL DEFAULT 0,
      purchase_count INTEGER DEFAULT 0,
      last_purchase_date TEXT,
      last_purchase_item TEXT,

      -- Lead scoring / ownership
      assigned_to TEXT,
      potential TEXT,           -- high / medium / low

      -- Pipeline (sequential: contacted -> answered -> appointment -> won)
      contacted INTEGER DEFAULT 0,
      answered INTEGER DEFAULT 0,
      appointment INTEGER DEFAULT 0,
      appointment_date TEXT,
      appointment_time TEXT,
      appointment_location TEXT,
      won INTEGER DEFAULT 0,

      -- Closed-lost (can happen from any stage)
      lost INTEGER DEFAULT 0,
      lost_reason TEXT,

      -- Stage timestamps
      contacted_at TEXT,
      answered_at TEXT,
      appointment_at TEXT,
      won_at TEXT,
      lost_at TEXT,

      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT,
      date TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- One row per Calendly booking. Kept separate from the flat
    -- clients.appointment* columns (used by the manual outreach STAGE_FLAGS
    -- chain in routes/clients.js) since a shop client can rebook/reorder and
    -- we need per-appointment status + reminder dedup, not a single slot.
    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      order_id TEXT,

      calendly_event_uri TEXT,
      calendly_invitee_uri TEXT,
      source TEXT NOT NULL DEFAULT 'postmessage_fallback', -- 'postmessage_fallback' | 'webhook'

      starts_at TEXT NOT NULL,   -- ISO 8601 UTC
      ends_at TEXT,
      location TEXT,
      status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | canceled | completed | no_show

      confirmation_email_sent_at TEXT,
      reminder_sent_at TEXT,

      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),

      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );

    -- One row per shop order, from deposit through balance payment.
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      appointment_id TEXT,
      order_number TEXT,

      -- Deposit / correlation with sly-shop's Stripe Checkout session
      stripe_checkout_session_id TEXT UNIQUE,
      stripe_deposit_payment_intent_id TEXT,
      deposit_amount_cents INTEGER,
      deposit_status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | failed | expired

      -- Product / config — staged at intake, overwritten by the order-taking
      -- tool once it exists (config_source flips to 'order_tool_final')
      product_type TEXT,
      config_json TEXT,
      config_source TEXT NOT NULL DEFAULT 'shop_intake', -- shop_intake | order_tool_final

      -- Balance, created by the future order-taking tool's /finalize call
      balance_amount_cents INTEGER,
      stripe_payment_link_id TEXT,
      stripe_payment_link_url TEXT,
      balance_stripe_session_id TEXT,
      balance_status TEXT NOT NULL DEFAULT 'not_created', -- not_created | link_created | paid | failed

      status TEXT NOT NULL DEFAULT 'deposit_pending',
        -- deposit_pending | deposit_paid | appointment_booked | finalized
        -- | balance_link_sent | balance_paid | canceled

      recap_email_sent_at TEXT,
      balance_confirmation_email_sent_at TEXT,

      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),

      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
      FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL
    );
  `);

  // Idempotent column adds for databases created before birthday automation existed.
  const addColumn = (table, col, def) => {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch (_) { /* exists */ }
  };
  addColumn('clients', 'birth_date', 'TEXT');
  addColumn('clients', 'email_opt_out', 'INTEGER DEFAULT 0');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_clients_assigned ON clients(assigned_to);
    CREATE INDEX IF NOT EXISTS idx_clients_target ON clients(target_contact_date);
    CREATE INDEX IF NOT EXISTS idx_clients_contacted ON clients(contacted);
    CREATE INDEX IF NOT EXISTS idx_clients_birth ON clients(birth_date);
    CREATE INDEX IF NOT EXISTS idx_messages_client ON messages(client_id);
    CREATE INDEX IF NOT EXISTS idx_messages_type_date ON messages(type, date);

    CREATE INDEX IF NOT EXISTS idx_appointments_client ON appointments(client_id);
    CREATE INDEX IF NOT EXISTS idx_appointments_starts ON appointments(starts_at);
    CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_calendly_event
      ON appointments(calendly_event_uri) WHERE calendly_event_uri IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_orders_client ON orders(client_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  `);

  // Seed default goal settings (only if absent) — SLY starts from zero, so
  // these are placeholders meant to be edited once real targets are known.
  const seed = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  const today = db.prepare("SELECT date('now') as d").get().d;
  seed.run('revenue_target', '10000');
  seed.run('avg_basket_target', '200');
  seed.run('daily_target', '3');
  seed.run('weekly_target', '15');
  seed.run('campaign_start', today);
  seed.run('campaign_deadline', '');
  seed.run('currency', '€');

  // Birthday email automation — disabled by default until RESEND_API_KEY is set
  // and the user has reviewed the template wording (see routes/automation.js).
  seed.run('automation_enabled', '0');
  seed.run('birthday_reminder_days_before', '30');
  seed.run('shop_url', '');
  seed.run('birthday_reminder_subject', 'Something for you before your birthday? 🎂');
  seed.run('birthday_reminder_body',
    "Hi {{first_name}},\n\nYour birthday is coming up next month — a good excuse to treat yourself to something new from SLY.\n\nTake a look: {{shop_url}}\n\nSee you soon,\nSLY");
  seed.run('birthday_greeting_subject', 'Happy birthday from SLY 🎉');
  seed.run('birthday_greeting_body',
    "Happy birthday {{first_name}}! 🎉\n\nWe hope you have a wonderful day.\n\nWarmly,\nSLY");

  // Order / appointment automation — same "off until configured" posture as
  // birthday automation. See routes/orders.js, routes/webhooks.js,
  // routes/appointments.js, lib/appointmentReminderJob.js.
  seed.run('order_number_seq', '0');

  seed.run('appointment_confirmation_subject', 'Your SLY appointment is confirmed 🎉');
  seed.run('appointment_confirmation_body',
    "Hi {{first_name}},\n\nYour appointment for your {{product_label}} is confirmed:\n\n{{appointment_date}} at {{appointment_time}}\n{{appointment_location}}\n\nSee you soon,\nSLY");

  seed.run('appointment_reminder_subject', 'Your SLY appointment is in 2 hours');
  seed.run('appointment_reminder_body',
    "Hi {{first_name}},\n\nJust a reminder — your appointment is coming up:\n\n{{appointment_date}} at {{appointment_time}}\n{{appointment_location}}\n\nSee you soon,\nSLY");

  seed.run('order_recap_subject', 'Your SLY order — {{product_label}}');
  seed.run('order_recap_body',
    "Hi {{first_name}},\n\nGreat meeting you! Here's a recap of your order:\n\n{{config_summary}}\n\nDeposit paid: {{deposit_amount}}\nBalance due: {{balance_amount}}\nTotal: {{total_amount}}\n\nComplete your order here: {{payment_link_url}}\n\nSLY");

  seed.run('balance_payment_confirmation_subject', 'Payment received — order {{order_reference}}');
  seed.run('balance_payment_confirmation_body',
    "Hi {{first_name}},\n\nWe've received your payment for order {{order_reference}} ({{product_label}}, {{total_amount}}).\n\nYour {{product_label}} is now headed to production. We'll be in touch with updates.\n\nThank you,\nSLY");
}

export default db;
