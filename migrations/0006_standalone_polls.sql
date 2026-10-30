CREATE TABLE standalone_polls (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE standalone_poll_votes (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES standalone_polls(id) ON DELETE CASCADE,
  choice TEXT NOT NULL CHECK(choice IN ('boy','girl')),
  cookie_hash TEXT NOT NULL,
  local_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX uq_standalone_poll_cookie ON standalone_poll_votes(poll_id, cookie_hash);
CREATE UNIQUE INDEX uq_standalone_poll_local ON standalone_poll_votes(poll_id, local_hash) WHERE local_hash IS NOT NULL;
