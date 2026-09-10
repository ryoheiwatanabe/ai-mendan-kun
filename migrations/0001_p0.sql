PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  active_revision_id TEXT,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_document_revisions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES knowledge_documents(id),
  owner_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public','interview','private')),
  approval_status TEXT NOT NULL CHECK (approval_status IN ('draft','approved','superseded','rejected','revoked')),
  index_state TEXT NOT NULL CHECK (index_state IN ('not_indexed','indexing','indexed','failed')),
  content TEXT NOT NULL,
  base_generation INTEGER NOT NULL,
  verification TEXT NOT NULL CHECK (verification IN ('self_reported','verified')),
  approved_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(document_id, content_hash)
);
CREATE INDEX IF NOT EXISTS revisions_access ON knowledge_document_revisions(owner_id,approval_status,visibility);
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES knowledge_document_revisions(id),
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  entities_json TEXT NOT NULL DEFAULT '[]',
  chunk_index INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_revision ON knowledge_chunks(revision_id);
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(chunk_id UNINDEXED, search_text, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS exact_facts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  revision_id TEXT NOT NULL REFERENCES knowledge_document_revisions(id),
  fact_key TEXT NOT NULL,
  fact_value TEXT NOT NULL,
  statement TEXT NOT NULL,
  aliases_json TEXT NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  supersedes_fact_id TEXT,
  approval_status TEXT NOT NULL CHECK (approval_status IN ('draft','approved','superseded','rejected','revoked')),
  visibility TEXT NOT NULL CHECK (visibility IN ('public','interview','private')),
  last_verified_at TEXT
);
CREATE INDEX IF NOT EXISTS facts_access ON exact_facts(owner_id,fact_key,approval_status,visibility);

-- 質問・回答本文は保存しない。乱用制限のカウンターだけを短期間保持する。
CREATE TABLE IF NOT EXISTS request_counters (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
