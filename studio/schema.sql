-- A.T. card studio
-- One row in templates is the card design (words + which blocks print).
-- cards are the physical pieces: a ref, a public code inside the QR, and the
-- design frozen at the moment the card was made.
-- work_orders are what a tap or scan should show after the card is loaded.
-- service_catalog is the standard order list. Rows marked on_card also print
-- on the back. Custom orders live only on work_orders.
-- accounts, payment_methods, and messages are reserved for a later step:
-- an account on the card, payment notes, and a message to the shop phone.
-- Do not store full card numbers in payment_methods.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS service_catalog (
  key TEXT PRIMARY KEY,
  problem TEXT NOT NULL,
  fix TEXT NOT NULL,
  on_card INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY,
  public_code TEXT NOT NULL UNIQUE,
  ref_no TEXT NOT NULL UNIQUE,
  template_id INTEGER NOT NULL REFERENCES templates(id),
  snapshot TEXT NOT NULL,
  status TEXT NOT NULL,
  client_name TEXT NOT NULL DEFAULT '',
  prepared_for TEXT NOT NULL DEFAULT '',
  card_date TEXT NOT NULL DEFAULT '',
  phone_display TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  back_mode TEXT NOT NULL DEFAULT 'menu',
  link_base TEXT NOT NULL,
  nfc_uid TEXT NOT NULL DEFAULT '',
  nfc_written_at TEXT,
  qr_confirmed_at TEXT,
  printed_at TEXT,
  loaded_at TEXT,
  account_id INTEGER REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_orders (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  catalog_key TEXT,
  problem TEXT NOT NULL,
  fix TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS card_events (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_methods (
  id INTEGER PRIMARY KEY,
  account_id INTEGER REFERENCES accounts(id),
  card_id INTEGER REFERENCES cards(id),
  label TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  card_id INTEGER REFERENCES cards(id),
  account_id INTEGER REFERENCES accounts(id),
  direction TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
CREATE INDEX IF NOT EXISTS idx_orders_card ON work_orders(card_id);
CREATE INDEX IF NOT EXISTS idx_events_card ON card_events(card_id);
