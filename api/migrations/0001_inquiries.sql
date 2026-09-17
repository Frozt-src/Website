CREATE TABLE IF NOT EXISTS inquiries (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT NOT NULL,
  service TEXT NOT NULL,
  team_size TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  consent_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS inquiries_created ON inquiries(created_at);
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_window ON rate_limits(window_start);
