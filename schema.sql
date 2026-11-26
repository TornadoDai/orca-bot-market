-- Orca Bot Talent Market D1 (SQLite) Schema
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'general',
  tags_json TEXT NOT NULL DEFAULT '[]',
  agent_hint TEXT NOT NULL DEFAULT 'claude',
  avatar_type TEXT NOT NULL DEFAULT 'mascot',
  avatar_value TEXT NOT NULL DEFAULT 'A1',
  avatar_color TEXT NOT NULL DEFAULT '#b3dbf4',
  author_name TEXT NOT NULL DEFAULT 'Community',
  author_handle TEXT NOT NULL DEFAULT '',
  trust TEXT NOT NULL DEFAULT 'community',
  featured INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  likes_count INTEGER NOT NULL DEFAULT 0,
  hires_count INTEGER NOT NULL DEFAULT 0,
  reports_count INTEGER NOT NULL DEFAULT 0,
  submitter_hash TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bots_status_created ON bots(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bots_status_category ON bots(status, category);
CREATE INDEX IF NOT EXISTS idx_bots_share_id ON bots(share_id);

CREATE TABLE IF NOT EXISTS likes (
  bot_id TEXT NOT NULL,
  client_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, client_hash)
);

CREATE TABLE IF NOT EXISTS hires (
  bot_id TEXT NOT NULL,
  client_hash TEXT NOT NULL,
  day_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, client_hash, day_key)
);

CREATE TABLE IF NOT EXISTS reports (
  bot_id TEXT NOT NULL,
  client_hash TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, client_hash)
);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT PRIMARY KEY,
  hits INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);
