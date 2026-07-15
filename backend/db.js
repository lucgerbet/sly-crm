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
}

export default db;
