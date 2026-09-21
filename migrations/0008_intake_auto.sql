-- 取り込みの自動リライト（#6）。包括許可に基づく自動採用を、本人の一語一句レビューと区別して記録する。
-- auto_policy_version: 自動適用した編集方針の版（intakeAutoPolicyVersion）。
-- auto_adopted=1 のときは、原文の版（source_hash）と公開payloadのhash（approved_hash）も併せて残る。
ALTER TABLE knowledge_intake_drafts ADD COLUMN auto_policy_version TEXT NOT NULL DEFAULT '';
ALTER TABLE knowledge_intake_drafts ADD COLUMN auto_adopted INTEGER NOT NULL DEFAULT 0;
