PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  baby_name TEXT,
  parent_names TEXT,
  event_date TEXT,
  event_time TEXT,
  venue TEXT,
  address TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS guests (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  max_guests INTEGER NOT NULL DEFAULT 1 CHECK(max_guests BETWEEN 1 AND 20),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS rsvps (
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL UNIQUE REFERENCES guests(id) ON DELETE CASCADE,
  attendance TEXT NOT NULL CHECK(attendance IN ('yes','no')),
  guest_count INTEGER NOT NULL DEFAULT 0 CHECK(guest_count BETWEEN 0 AND 20),
  message TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
CREATE INDEX IF NOT EXISTS idx_guests_event ON guests(event_id);
