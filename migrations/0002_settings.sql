CREATE TABLE app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
