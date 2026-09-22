-- 実行時にJEVが返した軸別スコアの控え。本文は保存せず、管理画面で採否例を確認するためだけに使う。
CREATE TABLE IF NOT EXISTS jev_score_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  settings_version INTEGER,
  kind TEXT NOT NULL,
  scores_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jev_score_samples_owner ON jev_score_samples(owner_id, id DESC);
