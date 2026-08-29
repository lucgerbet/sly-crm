import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
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
      referred_by TEXT, -- free-text name entered by the client at checkout — see addColumn note below

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
      config_summary TEXT, -- JSON [label, value][] — see addColumn note below
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

    -- One row per Fathom call recording. raw_payload is kept even after
    -- field extraction because Fathom's public API payload shape wasn't
    -- fully documented at integration time — see routes/webhooks.js's
    -- fathom handler comment. Matched to a client/order/appointment by
    -- invitee email + time proximity, best-effort (match_status tracks
    -- confidence so an unmatched call is never silently lost).
    CREATE TABLE IF NOT EXISTS call_transcripts (
      id TEXT PRIMARY KEY,
      fathom_recording_id TEXT,
      appointment_id TEXT,
      client_id TEXT,
      order_id TEXT,

      meeting_title TEXT,
      meeting_started_at TEXT,
      invitee_emails TEXT, -- JSON array

      transcript TEXT,
      summary TEXT,
      action_items TEXT, -- JSON

      match_status TEXT NOT NULL DEFAULT 'unmatched', -- matched | unmatched | ambiguous
      raw_payload TEXT NOT NULL,

      created_at TEXT DEFAULT (datetime('now')),

      FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
    );

    -- The catalogue: what SLY sells, what it costs, and what it earns.
    --
    -- Costs are stored in YUAN because that is the currency the workshop bills
    -- in and the one Luc negotiates in. Converting on entry would freeze a
    -- rate into the data and quietly falsify every past margin the day the
    -- rate moves; the conversion happens on read, against settings.cny_per_eur.
    --
    -- bonus_cny is the quality bonus paid to the workshop when the client is
    -- satisfied. It is a real cost of the business working as intended, so
    -- margins are computed with it — a margin that assumes every client is
    -- unhappy is not a margin worth planning on.
    --
    -- on_site decides whether sly-shop may offer it. Packs exist here for
    -- margin purposes long before they are for sale.
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,

      price_cents INTEGER,          -- selling price, in euro cents
      cost_cny REAL,                -- workshop cost, in yuan
      bonus_cny REAL DEFAULT 0,     -- quality bonus if the client is satisfied

      is_pack INTEGER NOT NULL DEFAULT 0,
      on_site INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      notes TEXT,

      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- SLY's own standard size chart: the bridge between a bespoke order's body
    -- measurements and a retail size everyone understands ("48", "M", "50R").
    -- Empty until Luc fills it in, and everything that reads it degrades to
    -- "unmatched" rather than guessing.
    --
    -- Ranges live in JSON rather than fixed columns because which measurements
    -- decide a size is Luc's call, not the schema's: a chart driven by chest
    -- and waist and one driven by chest, shoulder and height are both valid,
    -- and adding a driver must not need a migration.
    -- Shape: { "chest": {"min":96,"max":100}, "waistJacket": {...}, ... }
    CREATE TABLE IF NOT EXISTS size_standards (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      ranges_json TEXT NOT NULL DEFAULT '{}',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- One row per sly-shop pageview. No client cookies: visitor_hash is a
    -- server-side sha256(salt + ip + user-agent + calendar day), rotating
    -- daily so no single value ever identifies a return visitor across days —
    -- this is what lets analytics run without a cookie-consent banner.
    CREATE TABLE IF NOT EXISTS page_views (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      referrer_domain TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      visitor_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Idempotent column adds for databases created before birthday automation existed.
  const addColumn = (table, col, def) => {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch (_) { /* exists */ }
  };
  addColumn('clients', 'birth_date', 'TEXT');
  addColumn('clients', 'email_opt_out', 'INTEGER DEFAULT 0');
  // Human-readable [label, value] rows for the config, as computed by
  // sly-shop (same labels shown on-site) — lets the appointment-confirmation
  // PDF render a proper recap without duplicating sly-shop's option/label
  // lookup tables in this codebase.
  addColumn('orders', 'config_summary', 'TEXT');
  addColumn('clients', 'referred_by', 'TEXT');
  addColumn('clients', 'address', 'TEXT');
  addColumn('clients', 'tape_measure_sent_at', 'TEXT');
  // Answer to sly-shop's "do you have a sewing tape measure?" question, lifted
  // out of the raw config blob into a real column at intake. It was already
  // arriving inside config_json, but only as part of a display string — which
  // meant nothing could act on it, and the "send a tape" alert fired for every
  // client including the ones who said they already had one.
  addColumn('clients', 'needs_tape_measure', 'INTEGER DEFAULT 0');
  // Latest measurement snapshot, attached to the CLIENT rather than any one
  // order — measurements previously only lived inside a specific order's
  // config_json, invisible on the client's own profile and effectively lost
  // if that order was never reopened. Written by /orders/finalize (see
  // routes/orders.js) any time a meeting produces real measurement data;
  // never touched by anything else, so it always reflects the most recent
  // in-person meeting regardless of which order it came from.
  addColumn('clients', 'measurements_json', 'TEXT');
  addColumn('clients', 'measurements_updated_at', 'TEXT');
  addColumn('clients', 'measurements_order_id', 'TEXT');
  // Snapshot of config_summary as it stood at shop intake — unlike
  // config_summary (overwritten wholesale by /orders/finalize once the
  // stylist meeting is done), this column is only ever written by /intake,
  // so the client's original website selections survive finalize instead of
  // being silently lost. sly-shop's configurator uses a different option
  // vocabulary than the order-taking tool's (jacket style/cut/closure vs.
  // breasted/lapelType/etc.) so there's no field-level merge — the
  // pre-computed label/value rows are shown as-is, workshop-facing.
  addColumn('orders', 'shop_config_summary', 'TEXT');
  // Raw sly-shop Config object (same source as shop_config_summary, but the
  // actual field/value pairs, not pre-joined display strings) — lets the
  // order-taking tool pre-fill its own fields from the client's website
  // selections once deposit is paid + the appointment is booked, instead of
  // starting the stylist meeting from a blank form. See
  // sly-suit-meeting/src/lib/shopConfigMapping.ts for the field translation
  // (the two apps use different option vocabularies, so this is a best-effort
  // mapping, not a 1:1 passthrough).
  addColumn('orders', 'shop_config_json', 'TEXT');

  // ── Client discovery profile ──
  // Captured by the stylist during the meeting (sly-suit-meeting's Discovery
  // step) and pushed here via POST /api/clients/set-profile. Deliberately
  // split between free text (what the client actually said) and a small
  // closed vocabulary (what makes the client segmentable) — free text alone
  // can't answer "show me every client in finance with a wedding in 6
  // months", which is the whole point of collecting this.
  addColumn('clients', 'profession', 'TEXT');   // free text: "avocat", "directeur marketing"
  addColumn('clients', 'company', 'TEXT');
  addColumn('clients', 'job_title', 'TEXT');
  addColumn('clients', 'sector', 'TEXT');       // finance|law|tech|consulting|health|industry|entrepreneur|other
  addColumn('clients', 'suit_frequency', 'TEXT');   // daily|weekly|occasional|events-only
  addColumn('clients', 'travel_frequency', 'TEXT'); // often|sometimes|never
  addColumn('clients', 'wardrobe_size', 'TEXT');    // 0-1|2-4|5-10|10+
  addColumn('clients', 'style_direction', 'TEXT');  // classic|contemporary|bold|minimalist
  addColumn('clients', 'style_reference', 'TEXT');  // free text: the name they cite (legacy — no longer written by the meeting tool, kept for old data + manual CRM edits)
  addColumn('clients', 'interests', 'TEXT');        // JSON array of tags
  addColumn('clients', 'rtw_frustrations', 'TEXT'); // JSON array of tags (legacy — superseded by made_to_measure_reason below)
  addColumn('clients', 'rtw_frustrations_note', 'TEXT'); // their exact words — marketing copy source (legacy)
  // ISO 3166-1 alpha-2 code (e.g. "FR") — replaces the old free-text
  // birth city/country pair, which duplicated the general city/country
  // columns above without adding anything queryable.
  addColumn('clients', 'nationality', 'TEXT');
  // Why they're turning to made-to-measure at all — replaces the old
  // open-ended "what bothered you about off-the-rack" tag list with one
  // closed, comparable answer. experience|nothing-fits|time
  addColumn('clients', 'made_to_measure_reason', 'TEXT');
  addColumn('clients', 'made_to_measure_reason_note', 'TEXT'); // their exact words
  // Next event drives the follow-up pipeline: a wedding 8 months out is the
  // single strongest signal for when to reach back out.
  addColumn('clients', 'next_event_type', 'TEXT');
  addColumn('clients', 'next_event_date', 'TEXT');
  addColumn('clients', 'referral_interest', 'TEXT'); // yes|maybe|no
  addColumn('clients', 'referral_names', 'TEXT');
  // Topic-level opt-INs, collected at the end of the meeting. Distinct from
  // email_opt_out (a global suppression flag): these say what the client
  // actively wants to hear about, so a campaign can target them without
  // spamming everyone who merely hasn't unsubscribed.
  addColumn('clients', 'recontact_events', 'INTEGER DEFAULT 0');
  addColumn('clients', 'recontact_new_piece', 'INTEGER DEFAULT 0');
  addColumn('clients', 'recontact_seasonal', 'INTEGER DEFAULT 0');

  // ── Production / fulfilment tracking ──
  // Deliberately a SEPARATE axis from orders.status: that column tracks the
  // money (deposit → balance paid), this one tracks the garment (workshop →
  // client's hands). They genuinely move independently — a piece can be in
  // production while the balance is still unpaid — so folding them into one
  // enum would make both unrepresentable half the time.
  addColumn('orders', 'production_status', "TEXT NOT NULL DEFAULT 'not_started'");
    // not_started | sent_to_workshop | in_production | ready | shipped | received | delivered
    // (see lib/production.js — shipped onwards is the leg to the client)
  addColumn('orders', 'workshop_deadline', 'TEXT'); // date Luc needs it back by
  addColumn('orders', 'production_notes', 'TEXT');
  // One timestamp per stage rather than a single updated_at: "how long did
  // the workshop actually take" is the question that improves the promised
  // delivery window, and it can't be answered from a current-state column.
  addColumn('orders', 'sent_to_workshop_at', 'TEXT');
  addColumn('orders', 'in_production_at', 'TEXT');
  addColumn('orders', 'ready_at', 'TEXT');
  addColumn('orders', 'received_at', 'TEXT');
  addColumn('orders', 'shipped_at', 'TEXT');
  addColumn('orders', 'delivered_at', 'TEXT');
  addColumn('orders', 'carrier', 'TEXT');
  addColumn('orders', 'tracking_number', 'TEXT');
  // JSON array of stages whose client email has already gone out. Status can
  // legitimately be moved backwards (a correction), and a client must never
  // get "your piece has shipped" twice because of it.
  addColumn('orders', 'production_emails_sent', 'TEXT');

  // ── After-sales ──
  // A remake ("redo") is explicitly NOT a new order: the client bought one
  // piece and is owed one piece, so revenue, invoicing and history all have
  // to stay on the original row. Instead the production cycle simply runs
  // again with revision bumped, and the finished round is archived into
  // production_history so "round 1 took 5 weeks" survives the reset.
  addColumn('orders', 'revision', 'INTEGER DEFAULT 1');
  addColumn('orders', 'production_history', 'TEXT'); // JSON array of past rounds

  // Balance-payment chase. Both are dedup guards, not schedule state: the job
  // re-evaluates from recap_email_sent_at on every run, so a missed tick
  // catches up rather than skipping, and a stamped column means that client
  // can never receive the same chase twice.
  addColumn('orders', 'balance_reminder_1_sent_at', 'TEXT'); // 2 days after the recap
  addColumn('orders', 'balance_reminder_2_sent_at', 'TEXT'); // 5 working days after the recap

  // When the money actually cleared. deposit_status/balance_status say
  // *whether*, never *when* — so revenue could be totalled but not dated, and
  // "how much did I take in this month" was unanswerable. Stamped by the
  // Stripe webhook from here on; the backfill below fills in what already
  // happened.
  addColumn('orders', 'deposit_paid_at', 'TEXT');
  addColumn('orders', 'balance_paid_at', 'TEXT');

  // What the piece costs Luc — workshop, fabric, shipping. Nothing else in
  // the system knows this, so without it "net margin" is unanswerable.
  // Left NULL rather than defaulted to 0 on purpose: a missing cost is
  // "unknown", and treating unknown as zero would report the full sale price
  // as profit. Every margin figure below is computed only over orders that
  // actually have a cost, and reports how many were left out.
  addColumn('orders', 'cost_cents', 'INTEGER');

  // The price the site quoted the client (promo code already applied), sent
  // by sly-shop at intake. It is NOT the agreed total — that only exists once
  // the fitting call happens and /finalize records it — but without it an
  // order between deposit and call has no total at all, which reads on screen
  // as "we don't know what this order is worth" when the client was in fact
  // shown a price. Always displayed as a quote, never mixed silently with
  // confirmed totals.
  addColumn('orders', 'quoted_total_cents', 'INTEGER');

  // Workshop turnaround, reported by the workshop itself rather than guessed.
  // The docket email carries a link with this token; the workshop taps
  // "order received" then "production finished", and the two stamps below are
  // what every lead-time average in the CRM is built from. Stamped once and
  // never rewritten — a second tap must not restart the clock.
  // When the order-taking meeting was actually closed. Until now the only
  // trace was recap_email_sent_at, which is an email's timestamp and would
  // silently become wrong the day the recap is re-sent or fails to send.
  addColumn('orders', 'finalized_at', 'TEXT');

  addColumn('orders', 'workshop_token', 'TEXT');
  // When the workshop was last chased about an unopened docket. Kept so the
  // UI can show "relancé il y a 2 j" rather than inviting a third chase in an
  // afternoon.
  addColumn('orders', 'workshop_reminder_sent_at', 'TEXT');
  addColumn('orders', 'workshop_ack_at', 'TEXT');
  addColumn('orders', 'workshop_done_at', 'TEXT');
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_workshop_token ON orders(workshop_token)'); } catch (_) { /* exists */ }

  // One-time backfill for orders paid before those columns existed. Both are
  // approximations and deliberately conservative:
  //  - a deposit is paid within minutes of intake (the client is redirected
  //    straight to Stripe), so created_at is accurate to the day;
  //  - the balance confirmation email goes out inside the same webhook that
  //    records the payment, so its timestamp is the payment instant.
  // Only ever fills NULLs, so it can't overwrite a real stamped date and is
  // safe to re-run on every boot.
  // Orders finalized before finalized_at existed: the recap goes out within
  // seconds of the meeting closing, so it is accurate to the minute.
  db.exec(`
    UPDATE orders SET finalized_at = recap_email_sent_at
      WHERE finalized_at IS NULL AND recap_email_sent_at IS NOT NULL;
  `);

  db.exec(`
    UPDATE orders SET deposit_paid_at = created_at
      WHERE deposit_status = 'paid' AND deposit_paid_at IS NULL;
    UPDATE orders SET balance_paid_at = COALESCE(balance_confirmation_email_sent_at, updated_at)
      WHERE balance_status = 'paid' AND balance_paid_at IS NULL;
  `);
  // Prospect vs client is deliberately NOT this column — that's computed at
  // query time from real paid orders (see routes/clients.js), so it can
  // never drift out of sync with reality the way a manual flag could. This
  // column only captures what nothing else can infer: whether the email was
  // collected in person (a networking event, hand-entered by Luc) rather
  // than through the website's own lead capture / checkout — Luc's request
  // (2026-08-17), prompted by a lead ("Cyp Baron") who'd only ever given an
  // email online and was showing up indistinguishable from a real client.
  addColumn('clients', 'physical_prospect', 'INTEGER DEFAULT 0');

  db.exec(`
    -- One row per alteration round on an order. A table rather than columns
    -- because the same order can need several rounds, and each has its own
    -- seamstress, dates and reason — the second round is exactly the signal
    -- that something is going wrong, so it must not overwrite the first.
    -- The garment never goes back to China for this: the client drops it at
    -- a local seamstress, who ships it straight back to them when done.
    CREATE TABLE IF NOT EXISTS order_alterations (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      client_id TEXT,
      round INTEGER NOT NULL DEFAULT 1,

      reason TEXT,              -- what the client is unhappy about
      status TEXT NOT NULL DEFAULT 'needed',
        -- needed | booked | at_seamstress | shipped_back

      -- Kept on the row, not in a separate directory table: the UI suggests
      -- previously-used seamstresses by reading distinct values from here,
      -- which gives reuse without a whole CRUD surface to maintain.
      seamstress_name TEXT,
      seamstress_address TEXT,
      seamstress_phone TEXT,

      needed_at TEXT DEFAULT (datetime('now')),
      booked_at TEXT,
      dropped_off_at TEXT,
      shipped_back_at TEXT,

      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),

      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL
    );

    -- The client's own satisfaction answers, submitted from the link in the
    -- payment-confirmation email. Separate from order_feedback on purpose:
    -- that one is Luc's notes, taken face to face and therefore filtered by
    -- politeness. This one is written by the client alone, which is where the
    -- uncomfortable answers actually come from.
    --
    -- The token column is the whole access model: the page is public (a
    -- client cannot log in), so an unguessable per-order token is what
    -- authorises the submission, and it grants nothing beyond this survey.
    CREATE TABLE IF NOT EXISTS satisfaction_surveys (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      client_id TEXT,
      token TEXT NOT NULL UNIQUE,

      sent_at TEXT DEFAULT (datetime('now')),
      submitted_at TEXT,

      -- 1 to 5. Null until answered.
      rating_overall INTEGER,     -- l'expérience dans son ensemble
      rating_guidance INTEGER,    -- s'être senti conseillé
      rating_simplicity INTEGER,  -- simplicité et clarté du parcours
      rating_recommend INTEGER,   -- probabilité de recommander
      improvement TEXT,           -- champ libre

      created_at TEXT DEFAULT (datetime('now')),

      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL
    );

    -- One row per meeting, written at the end of the appointment from the
    -- stylist tool's Feedback step. Kept as its own table rather than columns
    -- on orders: a client can order several times and each meeting gets its
    -- own verbatim, which is what makes the answers comparable over time.
    CREATE TABLE IF NOT EXISTS order_feedback (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      client_id TEXT,

      experience_note TEXT,     -- "vous avez pensé quoi de cette expérience ?"
      time_saved TEXT,          -- yes | somewhat | no
      improvement_ideas TEXT,   -- "des idées pour améliorer ?"
      friction_points TEXT,     -- "quelque chose qui vous a soûlé / semblé compliqué ?"

      created_at TEXT DEFAULT (datetime('now')),

      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );

    -- "The SLY Experience" gift offer (2026-08-30): the buyer pays for a pack
    -- up front but never books — the beneficiary does, later, with this row's
    -- unique code column as their proof of payment. Deliberately its own table
    -- rather than an order from the start: an order needs a client (the
    -- buyer isn't necessarily ever a client) and represents one piece being
    -- made, while a gift card represents a sale that may or may not ever be
    -- redeemed, by someone whose identity is unknown at purchase time.
    CREATE TABLE IF NOT EXISTS gift_cards (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,               -- short, URL-safe — the QR code target
      pack_key TEXT NOT NULL,           -- products.key: pack_suit_shirt | pack_suit_3shirts | pack_suit_5shirts
      price_paid_cents INTEGER NOT NULL,

      stripe_checkout_session_id TEXT UNIQUE,

      buyer_first_name TEXT,
      buyer_last_name TEXT,
      buyer_email TEXT NOT NULL,

      beneficiary_name TEXT,   -- personalization only ("à l'attention de ...") — not a client record
      gift_message TEXT,

      -- Collected so Luc can also post a printed card by hand later — no
      -- automated fulfillment, this is just where the address lives.
      mailing_address TEXT,
      mailing_city TEXT,
      mailing_zip TEXT,

      status TEXT NOT NULL DEFAULT 'pending', -- pending (Stripe session open) | active (paid, unredeemed) | redeemed
      expires_at TEXT,     -- set once active — 12 months from payment
      redeemed_at TEXT,
      redeemed_order_id TEXT,

      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),

      FOREIGN KEY (redeemed_order_id) REFERENCES orders(id) ON DELETE SET NULL
    );
  `);

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

    CREATE INDEX IF NOT EXISTS idx_call_transcripts_client ON call_transcripts(client_id);
    CREATE INDEX IF NOT EXISTS idx_call_transcripts_appointment ON call_transcripts(appointment_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_call_transcripts_fathom_id
      ON call_transcripts(fathom_recording_id) WHERE fathom_recording_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_page_views_created ON page_views(created_at);
    CREATE INDEX IF NOT EXISTS idx_page_views_path ON page_views(path);
    CREATE INDEX IF NOT EXISTS idx_page_views_visitor ON page_views(visitor_hash);

    CREATE INDEX IF NOT EXISTS idx_order_feedback_client ON order_feedback(client_id);
    CREATE INDEX IF NOT EXISTS idx_order_feedback_order ON order_feedback(order_id);
    -- The survey page looks the row up by token on every visit, and the CRM
    -- lists a client's answers next to their meeting feedback.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_surveys_token ON satisfaction_surveys(token);
    CREATE INDEX IF NOT EXISTS idx_surveys_client ON satisfaction_surveys(client_id);
    CREATE INDEX IF NOT EXISTS idx_surveys_order ON satisfaction_surveys(order_id);
    -- The production board's two hot queries: "what's at each stage" and
    -- "what's past its workshop deadline".
    CREATE INDEX IF NOT EXISTS idx_orders_production_status ON orders(production_status);
    CREATE INDEX IF NOT EXISTS idx_orders_workshop_deadline ON orders(workshop_deadline);
    CREATE INDEX IF NOT EXISTS idx_order_alterations_order ON order_alterations(order_id);
    CREATE INDEX IF NOT EXISTS idx_order_alterations_status ON order_alterations(status);
    -- The follow-up pipeline query: who has an event coming up, soonest first.
    CREATE INDEX IF NOT EXISTS idx_clients_next_event ON clients(next_event_date);
    CREATE INDEX IF NOT EXISTS idx_clients_sector ON clients(sector);
    -- Looked up on every redemption-page visit and every configurator load
    -- carrying a ?giftCode=.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gift_cards_code ON gift_cards(code);
    CREATE INDEX IF NOT EXISTS idx_gift_cards_status ON gift_cards(status);
  `);

  // Added here, not in the addColumn block far above: that block runs before
  // order_alterations exists, so the ALTER silently failed and every
  // alteration read as costing nothing.
  addColumn('order_alterations', 'cost_cents', 'INTEGER');

  // Links a redeemed gift's resulting order back to the gift_cards row that
  // paid for it — added post-creation like the other late columns above
  // (gift_cards itself is created after orders, so it couldn't be a FK in
  // the original CREATE TABLE).
  addColumn('orders', 'gift_card_id', 'TEXT');

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

  // Margin inputs. What each piece costs to produce, per product type — the
  // workshop price is the same for every suit, so making Luc retype it on
  // every order would only be a way to get it wrong. A per-order cost_cents
  // still wins when set (an unusual fabric, a rush shipment); the default is
  // the fallback, not an override.
  // Only the suit has a confirmed figure (166 € — workshop + fabric, given by
  // Luc on 2026-08-20). The other two stay empty on purpose: guessing them
  // would produce a confident, wrong margin, which is worse than no margin.
  seed.run('default_cost_suit_cents', '16600');
  seed.run('default_cost_blazer_cents', '');
  seed.run('default_cost_trousers_cents', '');

  // What going wrong costs. A remake is a second piece out of the workshop
  // with nothing extra coming in, so it is pure loss and has to reach the
  // margin — a margin that ignores its own failures is a sales figure, not a
  // margin. 140 € is what SLY bears per remake (Luc, 2026-08-20).
  // The yuan/euro rate the catalogue converts at. One place, so no two
  // margins on the site can ever be computed at different rates.
  seed.run('cny_per_eur', '7.8');

  seed.run('redo_cost_cents', '14000');
  // Alterations have no standard cost yet. Left empty on purpose: an invented
  // figure would quietly move every margin on the dashboard. Individual
  // alterations can carry their own cost in the meantime (see
  // order_alterations.cost_cents), and those are always counted.
  seed.run('alteration_cost_cents', '');
  // Stripe's European card pricing at the time of writing. An estimate, not a
  // reading of the actual balance transaction — enough to stop margin being
  // overstated, and adjustable here when the real rate differs.
  seed.run('stripe_fee_percent', '1.5');
  seed.run('stripe_fee_fixed_cents', '25');

  // Catalogue rows. Prices and costs given by Luc on 2026-08-23; packs are
  // priced as a bundle, and their cost is the sum of what goes in them.
  // The "suit + 1 shirt" pack allows a cotton or a mix shirt: it is costed on
  // the cotton one, the dearer of the two, so the margin shown is the floor
  // rather than the best case.
  const product = db.prepare(`
    INSERT OR IGNORE INTO products (id, key, label, sort_order, price_cents, cost_cny, bonus_cny, is_pack, on_site)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  [
    ['suit',              'Costume',                  10,  64500, 1100, 200, 0, 1],
    ['blazer',            'Blazer',                   20,  47500,  800,  80, 0, 1],
    ['trousers',          'Pantalon',                 30,  19900,  300,  50, 0, 1],
    ['shirt_cotton',      'Chemise 100% coton',       40,  13500,  175,  25, 0, 0],
    ['shirt_mix',         'Chemise mix',              50,  13500,  125,  25, 0, 0],
    ['shirt_linen',       'Chemise 100% lin',         60,  13500,  220,  30, 0, 0],
    ['pack_suit_shirt',   'Costume + 1 chemise',      70,  72500, 1275, 225, 1, 0],
    ['pack_suit_3shirts', 'Costume + 3 chemises mix', 80,  87500, 1475, 275, 1, 0],
    ['pack_suit_5shirts', 'Costume + 5 chemises mix', 90,  99900, 1725, 325, 1, 0],
    ['pack_5shirts',      '5 chemises mix',          100,  40000,  625, 125, 1, 0],
  ].forEach(([key, label, order, price, cost, bonus, pack, site]) => {
    product.run(randomBytes(16).toString('hex'), key, label, order, price, cost, bonus, pack, site);
  });

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

  // Shared sign-off, interpolated as {{signature}} at the end of client-facing
  // templates — editable once (future Automation-tab UI) instead of
  // duplicated across every template body.
  seed.run('email_signature',
    'Luc Gerbet\nFondateur, SLY Atelier\ncontact@sly-atelier.com\nWhatsApp : +33 6 40 70 25 28');

  seed.run('appointment_confirmation_subject', 'Votre rendez-vous SLY Atelier est confirmé');
  seed.run('appointment_confirmation_body',
    "Bonjour {{first_name}},\n\nVotre rendez-vous pour votre {{product_label}} est confirmé.\n\nDate : {{appointment_date}}\nHeure : {{appointment_time}}\n{{appointment_location}}\n\nAvant le rendez-vous, merci de préparer :\n— Un mètre ruban de couturière (le vôtre, ou contactez-nous si vous n'en avez pas)\n— Une autre personne pour vous aider à prendre vos mesures\n— Un endroit calme avec une bonne connexion pour l'appel vidéo\n\nVous trouverez en pièce jointe le récapitulatif complet de votre présélection.\n\nÀ très bientôt,\n\n{{signature}}");

  seed.run('appointment_reminder_subject', 'Votre rendez-vous SLY Atelier est dans 2 heures');
  seed.run('appointment_reminder_body',
    "Bonjour {{first_name}},\n\nPetit rappel — votre rendez-vous approche :\n\nDate : {{appointment_date}}\nHeure : {{appointment_time}}\n{{appointment_location}}\n\nPensez à avoir sous la main un mètre ruban de couturière et un endroit calme avec une bonne connexion.\n\nÀ tout à l'heure,\n\n{{signature}}");

  // ── Balance-payment emails (recap + two chases) ──
  // Each one is split intro / outro around the payment button rather than
  // being one blob: the button is rendered structurally between them (see
  // lib/balanceEmails.js), which is what keeps the link inside the first few
  // lines instead of buried under a summary the client has to scroll past.
  // The amounts and the config table are rendered from the order itself, so
  // the editable text never has to repeat them or risk contradicting them.
  seed.run('order_recap_subject', 'Récapitulatif de votre commande SLY Atelier — {{product_label}}');
  seed.run('order_recap_intro',
    "Bonjour {{first_name}},\n\nVotre {{product_label}} est validé, tel que nous l'avons dessiné ensemble. Il ne reste que le solde à régler pour lancer la confection.");
  seed.run('order_recap_outro',
    "Vous trouverez ci-dessous le détail exact de ce que nous avons retenu. Si quelque chose ne correspond pas à ce que vous aviez en tête, dites-le moi avant le lancement en production.");
  // Retired in favour of the intro/outro pair above — kept out of the seed so
  // a fresh database doesn't carry a template nothing reads.

  seed.run('balance_reminder_1_subject', 'Votre {{product_label}} n\'attend plus que vous');
  seed.run('balance_reminder_1_intro',
    "Bonjour {{first_name}},\n\nVotre commande est prête à partir en confection. Le solde de {{balance_amount}} n'a pas encore été réglé, et c'est la seule chose qui manque.");
  seed.run('balance_reminder_1_outro',
    "Le lien reste valable, vous pouvez régler quand cela vous arrange. Si vous préférez un autre moyen de paiement, ou si vous avez une question sur la commande, répondez simplement à cet email.");

  seed.run('balance_reminder_2_subject', 'Votre {{product_label}} est en attente — solde à régler');
  seed.run('balance_reminder_2_intro',
    "Bonjour {{first_name}},\n\nVotre {{product_label}} est toujours en attente. Le solde de {{balance_amount}} reste à régler.");
  seed.run('balance_reminder_2_outro',
    "Pour être tout à fait transparent : la confection ne démarre qu'au règlement complet. Tant que le solde n'est pas réglé, votre pièce n'est pas lancée à l'atelier, et le délai de livraison court à partir de ce moment-là.\n\nSi quelque chose vous retient — un doute sur la commande, une contrainte de paiement — répondez-moi, on trouvera une solution.");

  // Thank-you sent the moment the balance clears. Split intro/outro around a
  // CTA like the other client emails — here the button is the satisfaction
  // survey rather than a payment link, since there is nothing left to pay.
  seed.run('balance_payment_confirmation_subject', 'Merci — votre {{product_label}} part en production');
  seed.run('balance_payment_confirmation_intro',
    "Bonjour {{first_name}},\n\nVotre règlement est bien reçu, et votre {{product_label}} part maintenant en confection. Merci de votre confiance.\n\nAvant de vous laisser : deux minutes pour me dire comment vous avez vécu la commande ? C'est ce qui me permet de faire mieux la fois suivante.");
  seed.run('balance_payment_confirmation_outro',
    "Je vous tiendrai informé de l'avancement, et vous préviendrai dès que votre pièce prendra la route.");

  // The survey itself. Asked at payment, so it can only be about the ordering
  // experience — the piece hasn't been made yet, let alone worn.
  seed.run('survey_intro',
    "Votre avis sur la commande");
  seed.run('survey_q_overall', "Globalement, comment avez-vous vécu l'expérience ?");
  seed.run('survey_q_guidance', "Vous êtes-vous senti bien conseillé et guidé ?");
  seed.run('survey_q_simplicity', "Le parcours vous a-t-il paru simple et clair ?");
  seed.run('survey_q_recommend', "Recommanderiez-vous SLY Atelier autour de vous ?");
  seed.run('survey_q_improvement', "Qu'est-ce qui rendrait l'expérience meilleure la prochaine fois ?");

  // Internal alert to Luc, not the client — fires when a new deposit is paid
  // and this client has never had a measuring tape sent (clients.tape_measure_sent_at
  // still null). Same address already used for the sly-shop "new order" alert,
  // kept in one editable setting instead of hardcoded across two codebases.
  // Where Luc buys the tape measures. Stored once and reused on every row of
  // the "tapes to send" queue, so ordering one is a click rather than a
  // search. Empty until he pastes his link — the button simply doesn't show
  // until then, rather than opening a guessed product page.
  seed.run('tape_measure_product_url', '');
  seed.run('tape_measure_notify_email', 'gerbetluc2218@gmail.com');
  seed.run('tape_measure_alert_subject', 'Mètre ruban à envoyer — {{first_name}} {{last_name}}');
  seed.run('tape_measure_alert_body',
    "Nouvelle commande avec acompte payé, et ce client n'a pas encore reçu de mètre ruban.\n\nClient : {{first_name}} {{last_name}}\nEmail : {{email}}\nAdresse : {{address}}\nCommande : {{order_reference}} ({{product_label}})\n\nPense à commander/envoyer le mètre ruban, puis coche « Mètre ruban envoyé » sur la fiche client dans le CRM.");

  // Internal review email to Luc, not the client and NOT the workshop —
  // fires once a meeting is finalized, with the production-ready order form
  // (PDF, replicating the workshop's own docket) attached for him to check
  // before forwarding it himself. See lib/pdf.js buildProductionOrderPdf.
  seed.run('production_order_notify_email', 'gerbetluc2218@gmail.com');
  seed.run('production_order_subject', 'Bon de commande à vérifier — {{order_reference}}');
  seed.run('production_order_body',
    "Commande finalisée : {{first_name}} {{last_name}} ({{order_reference}}, {{product_label}}).\n\nLe bon de commande pour l'atelier de production est en pièce jointe. Vérifie-le avant de l'envoyer à l'atelier.");

  // Sent directly to the production workshop — deliberately NOT wired to
  // fire automatically at /finalize (unlike production_order_notify_email
  // above): Luc triggers it himself via a "Send to workshop" button once
  // he's reviewed the PDF (see POST /api/orders/send-to-workshop). Empty
  // until Luc gives the real workshop email — the send route refuses to run
  // rather than silently emailing nobody or the wrong address.
  seed.run('workshop_notify_email', '');
  // English and Chinese: this is the only email in the system that leaves for
  // the workshop in China, and French would be no use to them. Editable in
  // Automation like every other template.
  seed.run('workshop_order_subject', 'Production order {{order_reference}} · 生产订单');
  // The chase, for when the docket sits unopened. Firmer than the first email
  // and says why it matters, without being rude — this is a supplier, not a
  // late-paying client.
  seed.run('workshop_reminder_subject', 'Reminder — production order {{order_reference}} · 催单提醒');
  seed.run('workshop_reminder_body',
    "Hello,\n\nWe have not seen the production order for {{first_name}} {{last_name}} "
    + "({{order_reference}}, {{product_label}}) opened yet. Could you confirm you have it "
    + "and let us know the expected completion date?\n\n"
    + "您好，\n\n{{first_name}} {{last_name}} 的生产订单（{{order_reference}}，{{product_label}}）"
    + "尚未被打开。请确认已收到，并告知预计完成日期。\n\nThank you · 谢谢\nSLY Atelier");
  seed.run('workshop_order_body',
    "Hello,\n\nHere is the production order for {{first_name}} {{last_name}} "
    + "({{order_reference}}, {{product_label}}). Tap the button below to open the PDF.\n\n"
    + "您好，\n\n这是 {{first_name}} {{last_name}} 的生产订单（{{order_reference}}，{{product_label}}）。"
    + "请点击下方按钮打开 PDF 文件。\n\nThank you · 谢谢\nSLY Atelier");

  // Client-facing production updates. Only two stages email the client:
  // "we've started making it" and "it's on its way" — the intermediate
  // internal moves (sent to workshop, received, quality-checked) are Luc's
  // logistics, not news the client asked for, and emailing every step turns
  // a premium experience into notification noise.
  seed.run('production_in_production_subject', 'Votre {{product_label}} est en cours de confection');
  seed.run('production_in_production_body',
    "Bonjour {{first_name}},\n\nVotre {{product_label}} ({{order_reference}}) vient d'entrer en confection à l'atelier.\n\nChaque pièce est taillée et montée à la main d'après vos mesures. Nous vous préviendrons dès qu'elle prendra la route.\n\nÀ très bientôt,\n\n{{signature}}");

  // Sent only when Luc presses the button, never automatically. A client who
  // needs an alteration is a client who isn't happy yet — that conversation
  // belongs to him, not to a scheduler. What IS worth automating is the part
  // the client actually needs in writing: where to bring the piece.
  seed.run('alteration_details_subject', 'Retouche de votre {{product_label}} — où déposer la pièce');
  seed.run('alteration_details_body',
    "Bonjour {{first_name}},\n\nComme convenu, voici les coordonnées de l'atelier de retouche pour votre {{product_label}} ({{order_reference}}).\n\n{{seamstress_name}}\n{{seamstress_address}}\n{{seamstress_phone}}\n\nVous pouvez y déposer la pièce quand cela vous arrange. Une fois la retouche terminée, elle vous sera renvoyée directement chez vous.\n\nJe reste joignable pour la moindre question.\n\n{{signature}}");

  seed.run('production_shipped_subject', 'Votre {{product_label}} est en route');
  seed.run('production_shipped_body',
    "Bonjour {{first_name}},\n\nVotre {{product_label}} ({{order_reference}}) vient de partir.\n\nTransporteur : {{carrier}}\nNuméro de suivi : {{tracking_number}}\n\nNous restons à votre disposition pour la moindre question à la réception.\n\nÀ très bientôt,\n\n{{signature}}");

  // Two layers for the Fathom webhook: the random path segment below (own
  // unguessable URL, always active) plus fathom_webhook_secret — the real
  // "whsec_..." Svix signing secret Fathom hands back when the webhook is
  // registered (see lib/fathom.js verifyFathomSignature), set manually
  // after that registration since it's a live credential, not a default.
  // seed.run is INSERT OR IGNORE, so this only takes effect on the very
  // first run — stable across every restart after that.
  seed.run('fathom_webhook_token', randomBytes(24).toString('hex'));
  seed.run('fathom_webhook_secret', '');

  // Internal notification to Luc when a Fathom call recording comes in —
  // two variants depending on whether it auto-matched to a known client's
  // appointment (see lib/fathom.js matchFathomCall), since an unmatched call
  // needs manual follow-up he'd otherwise never know happened.
  seed.run('fathom_call_notify_email', 'gerbetluc2218@gmail.com');
  seed.run('fathom_call_matched_subject', 'Compte-rendu d\'appel — {{client_name}} ({{order_reference}})');
  seed.run('fathom_call_matched_body',
    "Transcription et résumé disponibles pour l'appel avec {{client_name}} ({{order_reference}}).\n\nRésumé Fathom :\n{{summary}}\n\nLa transcription complète est enregistrée dans le CRM.");
  seed.run('fathom_call_unmatched_subject', 'Appel Fathom non rattaché à une commande — {{meeting_title}}');
  seed.run('fathom_call_unmatched_body',
    "Un enregistrement Fathom est arrivé (\"{{meeting_title}}\") mais n'a pas pu être rattaché automatiquement à un client/commande (statut : {{match_status}}).\n\nRésumé Fathom :\n{{summary}}\n\nÀ vérifier manuellement dans le CRM.");

  // Shared address for new internal notifications (2026-08-12) — kept
  // separate from the three existing notify-email settings above rather
  // than reusing one of them, so each can still be redirected independently
  // later without side effects on the others. Luc reported never getting a
  // "you got paid" email at all (only the tape-measure alert incidentally
  // touches his inbox on deposit, and only conditionally) — these two fire
  // unconditionally on every deposit/balance webhook.
  seed.run('internal_notify_email', 'gerbetluc2218@gmail.com');
  seed.run('deposit_received_subject', 'Acompte reçu — {{first_name}} {{last_name}} ({{order_reference}})');
  seed.run('deposit_received_body',
    "Acompte reçu sur Stripe.\n\nClient : {{first_name}} {{last_name}}\nEmail : {{email}}\nCommande : {{order_reference}} ({{product_label}})\nMontant de l'acompte : {{deposit_amount}}\n\nVoir la fiche client dans le CRM pour le détail.");
  seed.run('balance_received_subject', 'Solde reçu — {{first_name}} {{last_name}} ({{order_reference}})');
  seed.run('balance_received_body',
    "Solde reçu sur Stripe — commande soldée.\n\nClient : {{first_name}} {{last_name}}\nEmail : {{email}}\nCommande : {{order_reference}} ({{product_label}})\nMontant du solde : {{balance_amount}}\nTotal commande : {{total_amount}}\n\nVoir la fiche client dans le CRM pour le détail.");

  // Random per-install salt for the daily-rotating visitor_hash in
  // page_views (see routes/analytics.js) — never exposed via any API route.
  seed.run('analytics_hash_salt', randomBytes(24).toString('hex'));

  // "The SLY Experience" gift offer (2026-08-30). Sent to the BUYER — they're
  // the one who presents the card to whoever they're gifting it to, so they
  // need it in hand, not the (often still-unknown-at-purchase) beneficiary.
  // {{qr_code_cid}} isn't a template variable substituted here — it's a
  // marker the HTML builder (routes/webhooks.js) replaces with the actual
  // embedded QR image, kept out of renderTemplate's plain {{key}} scheme on
  // purpose since it's markup, not text.
  seed.run('gift_purchased_subject', 'Votre SLY Experience est prête à offrir — {{beneficiary_name}}');
  seed.run('gift_purchased_body',
    "Merci pour votre commande !\n\nVotre SLY Experience ({{pack_label}}, {{price_paid}}) est prête. Faites scanner le QR code de cette carte à la personne à qui vous l'offrez — {{beneficiary_name}} — pour qu'elle puisse choisir son style et réserver son rendez-vous avec Luc, sans rien avoir à payer.\n\nCette carte est valable jusqu'au {{expires_at}}.\n\nLien direct si le QR code ne s'affiche pas : {{redeem_url}}");
  seed.run('internal_gift_purchased_subject', 'SLY Experience vendue — {{buyer_first_name}} {{buyer_last_name}}');
  seed.run('internal_gift_purchased_body',
    "Nouvelle SLY Experience achetée.\n\nAcheteur : {{buyer_first_name}} {{buyer_last_name}} ({{buyer_email}})\nPack : {{pack_label}} — {{price_paid}}\nÀ l'attention de : {{beneficiary_name}}\nCode : {{code}}\n\nVoir la fiche dans le CRM pour le détail (adresse postale si fournie pour l'envoi d'une carte imprimée).");
  seed.run('internal_gift_redeemed_subject', 'SLY Experience utilisée — {{first_name}} {{last_name}}');
  seed.run('internal_gift_redeemed_body',
    "Une carte SLY Experience vient d'être utilisée.\n\nBénéficiaire : {{first_name}} {{last_name}} ({{email}})\nPack : {{pack_label}}\nCommande : {{order_reference}}\n\nDéjà entièrement réglé — rien à encaisser, rendez-vous à honorer normalement.");
}

export default db;
