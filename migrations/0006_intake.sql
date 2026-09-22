-- 取り込み（#5）の管理専用テーブル。公開検索の経路（chunks/facts/FTS/Vectorize）からは読まない。
CREATE TABLE IF NOT EXISTS knowledge_intake_sources (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  replaces_revision_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS intake_sources_owner ON knowledge_intake_sources(owner_id,created_at);

CREATE TABLE IF NOT EXISTS knowledge_intake_drafts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES knowledge_intake_sources(id),
  status TEXT NOT NULL CHECK (status IN ('draft','held','approved','rejected')),
  title TEXT NOT NULL,
  public_text TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  topic TEXT NOT NULL DEFAULT '',
  kept_json TEXT NOT NULL DEFAULT '[]',
  omitted_json TEXT NOT NULL DEFAULT '[]',
  questions_json TEXT NOT NULL DEFAULT '[]',
  model TEXT NOT NULL DEFAULT '',
  prompt_version TEXT NOT NULL DEFAULT '',
  source_hash TEXT NOT NULL DEFAULT '',
  approved_revision_id TEXT,
  approved_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS intake_drafts_owner ON knowledge_intake_drafts(owner_id,created_at);

