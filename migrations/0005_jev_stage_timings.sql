-- 段階ごとの所要時間。本文は保存せず、p50/p95と修復率の確認だけに使う。
CREATE TABLE IF NOT EXISTS jev_stage_timings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  stage TEXT NOT NULL,
  ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jev_stage_timings_owner ON jev_stage_timings(owner_id, id DESC);
