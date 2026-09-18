-- 本人が管理画面から調整するJEVの採点設定。版ごとに追記し、直前の版へ戻せる形で残す。
CREATE TABLE IF NOT EXISTS jev_settings_versions (
  owner_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  PRIMARY KEY (owner_id, version)
);
