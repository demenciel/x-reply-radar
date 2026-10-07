CREATE TABLE radar_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value TEXT NOT NULL
);
INSERT INTO radar_state VALUES (1, '{}');
CREATE TABLE lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO lease (id) VALUES (1);
CREATE TABLE tweets (
  id TEXT PRIMARY KEY,
  tweet TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('baseline','seen','generated','sending','emailed','skipped','failed','uncertain')),
  result TEXT,
  payload TEXT,
  generation_attempts INTEGER NOT NULL DEFAULT 0,
  email_attempts INTEGER NOT NULL DEFAULT 0,
  send_started_at INTEGER,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  email_id TEXT,
  error_code TEXT
);
CREATE INDEX tweets_pending ON tweets(status, next_attempt_at, created_at);
CREATE INDEX tweets_retention ON tweets(updated_at);
-- Compact permanent receipts prevent repeated manual tests after payload retention ends.
CREATE TABLE email_receipts (
  id TEXT PRIMARY KEY,
  first_attempt_at INTEGER NOT NULL,
  email_id TEXT
);
CREATE TABLE counters (
  day TEXT PRIMARY KEY,
  twitter_calls INTEGER NOT NULL DEFAULT 0,
  llm_calls INTEGER NOT NULL DEFAULT 0,
  email_attempts INTEGER NOT NULL DEFAULT 0,
  emails_sent INTEGER NOT NULL DEFAULT 0
);
