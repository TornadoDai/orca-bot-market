-- Migration 002: Direct sanitized recipe sharing & auto-generated share links
ALTER TABLE bots ADD COLUMN share_code TEXT NOT NULL DEFAULT '';
ALTER TABLE bots ADD COLUMN share_mode TEXT NOT NULL DEFAULT 'orca_link';
ALTER TABLE bots ADD COLUMN soul_md TEXT NOT NULL DEFAULT '';
ALTER TABLE bots ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE bots ADD COLUMN watches TEXT NOT NULL DEFAULT '';
ALTER TABLE bots ADD COLUMN does_text TEXT NOT NULL DEFAULT '';
ALTER TABLE bots ADD COLUMN reports TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_bots_share_code ON bots(share_code);
