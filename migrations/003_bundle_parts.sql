-- Migration 003: Optional sanitized bundle parts (skills, automations, tools, memory, settings)
ALTER TABLE bots ADD COLUMN bundle_json TEXT NOT NULL DEFAULT '{}';
