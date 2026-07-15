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

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_clients_assigned ON clients(assigned_to);
    CREATE INDEX IF NOT EXISTS idx_clients_target ON clients(target_contact_date);
    CREATE INDEX IF NOT EXISTS idx_clients_contacted ON clients(contacted);
    CREATE INDEX IF NOT EXISTS idx_messages_client ON messages(client_id);
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
}

export default db;
