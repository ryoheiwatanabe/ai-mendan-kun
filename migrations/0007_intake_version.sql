-- 取り込み下書きの版番号。画面の編集と保存の食い違い（別タブ・未保存編集）を承認時に検出する。
ALTER TABLE knowledge_intake_drafts ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
