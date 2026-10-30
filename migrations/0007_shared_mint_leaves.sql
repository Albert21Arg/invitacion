CREATE TABLE mint_leaf_cycles (
  scope_key TEXT PRIMARY KEY,
  cycle_id INTEGER NOT NULL DEFAULT 0,
  cycle_started_at INTEGER NOT NULL
);

CREATE TABLE mint_leaf_falls (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL REFERENCES mint_leaf_cycles(scope_key) ON DELETE CASCADE,
  cycle_id INTEGER NOT NULL,
  leaf_count INTEGER NOT NULL CHECK(leaf_count BETWEEN 1 AND 120),
  boy_count INTEGER NOT NULL DEFAULT 0,
  girl_count INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  UNIQUE(scope_key, cycle_id)
);

CREATE INDEX idx_mint_leaf_falls_scope_started ON mint_leaf_falls(scope_key, started_at);
