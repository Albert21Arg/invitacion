ALTER TABLE standalone_polls ADD COLUMN reveal_result TEXT CHECK(reveal_result IN ('boy','girl'));
ALTER TABLE standalone_polls ADD COLUMN revealed_at TEXT;
