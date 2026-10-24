PRAGMA foreign_keys = ON;
ALTER TABLE events ADD COLUMN event_type TEXT NOT NULL DEFAULT 'baby_shower' CHECK(event_type IN ('baby_shower','gender_reveal'));
ALTER TABLE events ADD COLUMN vote_status TEXT NOT NULL DEFAULT 'open' CHECK(vote_status IN ('open','closed'));
ALTER TABLE events ADD COLUMN reveal_result TEXT CHECK(reveal_result IN ('boy','girl'));
ALTER TABLE events ADD COLUMN revealed_at TEXT;
CREATE TABLE IF NOT EXISTS votes (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  guest_id TEXT REFERENCES guests(id) ON DELETE SET NULL,
  choice TEXT NOT NULL CHECK(choice IN ('boy','girl')),
  cookie_hash TEXT NOT NULL,
  local_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_votes_cookie ON votes(event_id, cookie_hash);
CREATE UNIQUE INDEX IF NOT EXISTS uq_votes_local ON votes(event_id, local_hash) WHERE local_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_votes_guest ON votes(guest_id);
