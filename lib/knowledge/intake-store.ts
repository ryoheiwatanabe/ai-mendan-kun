import type { Database } from "../types.ts";
import type { IntakeOmitted } from "./intake.ts";

// 取り込みの管理データ（#5）。原文・下書き・省略メモは管理専用で、公開検索の経路からは読まない。
export type IntakeStatus = "draft" | "held" | "approved" | "rejected";
export type IntakeSourceRecord = { id: string; owner_id: string; title: string; raw_text: string; content_hash: string;
  replaces_revision_id: string | null; created_at: string };
export type IntakeDraftRecord = { id: string; owner_id: string; source_id: string; status: IntakeStatus; title: string;
  public_text: string; aliases_json: string; topic: string; kept_json: string; omitted_json: string; questions_json: string;
  model: string; prompt_version: string; source_hash: string; approved_revision_id: string | null; approved_hash: string | null;
  auto_policy_version: string; auto_adopted: number; created_at: string; updated_at: string; version: number };

export type IntakeSourceView = { id: string; title: string; contentHash: string; replacesRevisionId: string | null; createdAt: string };
export type IntakeDraftView = { id: string; sourceId: string; status: IntakeStatus; title: string; publicText: string;
  aliases: string[]; topic: string; kept: string[]; omitted: IntakeOmitted[]; questions: string[]; model: string;
  promptVersion: string; approvedRevisionId: string | null;
  // 自動リライト（#6）で採用した方針の版。autoAdoptedが真なら、本人の一語一句レビューではない。
  autoPolicyVersion: string; autoAdopted: boolean; createdAt: string; updatedAt: string; version: number };

export function intakeJsonList(value: string): string[] {
  try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; }
  catch { return []; }
}
export function intakeJsonOmitted(value: string): IntakeOmitted[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(entry => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as { item?: unknown; reason?: unknown };
      return typeof record.item === "string" && typeof record.reason === "string" ? [{ item: record.item, reason: record.reason }] : [];
    });
  } catch { return []; }
}

export function sourceView(record: IntakeSourceRecord): IntakeSourceView {
  return { id: record.id, title: record.title, contentHash: record.content_hash,
    replacesRevisionId: record.replaces_revision_id, createdAt: record.created_at };
}
export function draftView(record: IntakeDraftRecord): IntakeDraftView {
  return { id: record.id, sourceId: record.source_id, status: record.status, title: record.title, publicText: record.public_text,
    aliases: intakeJsonList(record.aliases_json), topic: record.topic, kept: intakeJsonList(record.kept_json),
    omitted: intakeJsonOmitted(record.omitted_json), questions: intakeJsonList(record.questions_json), model: record.model,
    promptVersion: record.prompt_version, approvedRevisionId: record.approved_revision_id,
    autoPolicyVersion: record.auto_policy_version ?? "", autoAdopted: (record.auto_adopted ?? 0) === 1,
    createdAt: record.created_at, updatedAt: record.updated_at, version: record.version ?? 1 };
}

const sourceColumns = "id,owner_id,title,raw_text,content_hash,replaces_revision_id,created_at";
const draftColumns = "id,owner_id,source_id,status,title,public_text,aliases_json,topic,kept_json,omitted_json,questions_json,model,prompt_version,source_hash,approved_revision_id,approved_hash,auto_policy_version,auto_adopted,created_at,updated_at,version";

export async function createIntakeSource(db: Database, record: IntakeSourceRecord): Promise<void> {
  await db.prepare(`INSERT INTO knowledge_intake_sources(${sourceColumns}) VALUES(?,?,?,?,?,?,?)`).bind(record.id, record.owner_id,
    record.title, record.raw_text, record.content_hash, record.replaces_revision_id, record.created_at).run();
}
export async function getIntakeSource(db: Database, ownerId: string, id: string): Promise<IntakeSourceRecord | null> {
  return db.prepare(`SELECT ${sourceColumns} FROM knowledge_intake_sources WHERE id=? AND owner_id=?`).bind(id, ownerId)
    .first<IntakeSourceRecord>();
}
export async function createIntakeDraft(db: Database, record: IntakeDraftRecord): Promise<void> {
  await db.prepare(`INSERT INTO knowledge_intake_drafts(${draftColumns}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(record.id,
    record.owner_id, record.source_id, record.status, record.title, record.public_text, record.aliases_json, record.topic,
    record.kept_json, record.omitted_json, record.questions_json, record.model, record.prompt_version, record.source_hash,
    record.approved_revision_id, record.approved_hash, record.auto_policy_version, record.auto_adopted,
    record.created_at, record.updated_at, record.version).run();
}
export async function getIntakeDraft(db: Database, ownerId: string, id: string): Promise<IntakeDraftRecord | null> {
  return db.prepare(`SELECT ${draftColumns} FROM knowledge_intake_drafts WHERE id=? AND owner_id=?`).bind(id, ownerId)
    .first<IntakeDraftRecord>();
}
export async function listIntake(db: Database, ownerId: string) {
  const sources = await db.prepare(`SELECT ${sourceColumns} FROM knowledge_intake_sources WHERE owner_id=? ORDER BY created_at DESC LIMIT 20`)
    .bind(ownerId).all<IntakeSourceRecord>();
  const drafts = await db.prepare(`SELECT ${draftColumns} FROM knowledge_intake_drafts WHERE owner_id=? ORDER BY created_at DESC LIMIT 20`)
    .bind(ownerId).all<IntakeDraftRecord>();
  return { sources: sources.results.map(sourceView), drafts: drafts.results.map(draftView) };
}

// 公開文と検索語の編集。状態（下書き／保留）もここで切り替える。
export async function updateIntakeDraft(db: Database, ownerId: string, id: string, change: { title: string; publicText: string;
  aliases: string[]; topic: string; status: IntakeStatus; updatedAt: string }): Promise<void> {
  // 保存のたびに版番号を進める。承認はこの版番号が一致するときだけ行う。
  // 本人が手を入れた下書きは、自動採用の対象から外す（古い再送で後操作を上書きしない）。
  await db.prepare(`UPDATE knowledge_intake_drafts SET title=?,public_text=?,aliases_json=?,topic=?,status=?,auto_policy_version='',auto_adopted=0,updated_at=?,version=version+1 WHERE id=? AND owner_id=?`)
    .bind(change.title, change.publicText, JSON.stringify(change.aliases), change.topic, change.status, change.updatedAt, id, ownerId).run();
}
// 期限を過ぎた確保を、1つの要求だけが引き継げるようにする（versionとclaim tokenによるcompare-and-set）。
// 引き継げた要求だけが、同じIDのまま生成からやり直す。
export async function claimExpiredIntakeDraft(db: Database, ownerId: string, id: string, expectedVersion: number,
  token: string, now: string): Promise<boolean> {
  await db.prepare(`UPDATE knowledge_intake_drafts SET auto_policy_version=?,updated_at=?,version=version+1
    WHERE id=? AND owner_id=? AND version=? AND status='draft' AND public_text=''`)
    .bind(token, now, id, ownerId, expectedVersion).run();
  const row = await db.prepare(`SELECT auto_policy_version FROM knowledge_intake_drafts WHERE id=? AND owner_id=?`)
    .bind(id, ownerId).first<{ auto_policy_version: string }>();
  return row?.auto_policy_version === token;
}
export async function markIntakeApproved(db: Database, ownerId: string, id: string,
  approved: { revisionId: string; hash: string; updatedAt: string }): Promise<void> {
  // 手動の再承認を自動採用と混同しないよう、自動の印と方針の版を消してから記録する。
  await db.prepare(`UPDATE knowledge_intake_drafts SET status='approved',approved_revision_id=?,approved_hash=?,auto_policy_version='',auto_adopted=0,updated_at=? WHERE id=? AND owner_id=?`)
    .bind(approved.revisionId, approved.hash, approved.updatedAt, id, ownerId).run();
}
// 生成した候補を、管理用のメモ（残した要点・省略・要確認）ごと保存する。
// 再送で点検・公開の末尾から再開するとき、LLMで作り直さず同じ候補を使い回すために使う。
// 同じ試行（版と自動token、状態が下書き）のときだけ書き込む。生成中に本人が保存・却下・取消した場合は
// 書き込まず、後操作を優先する（遅れて戻ってきた生成で上書きしない）。
export async function updateIntakeCandidate(db: Database, ownerId: string, id: string,
  attempt: { version: number; token: string }, change: { title: string; publicText: string; aliases: string[]; topic: string;
    kept: string[]; omitted: IntakeOmitted[]; questions: string[]; status: IntakeStatus; updatedAt: string }): Promise<boolean> {
  // RETURNINGで、実際に書き換えた要求だけを成功とみなす（同じ版の2要求が両方成功しないようにする）。
  const row = await db.prepare(`UPDATE knowledge_intake_drafts SET title=?,public_text=?,aliases_json=?,topic=?,kept_json=?,omitted_json=?,questions_json=?,status=?,updated_at=?,version=version+1
    WHERE id=? AND owner_id=? AND version=? AND auto_policy_version=? AND status='draft'
    RETURNING version`)
    .bind(change.title, change.publicText, JSON.stringify(change.aliases), change.topic, JSON.stringify(change.kept),
      JSON.stringify(change.omitted), JSON.stringify(change.questions), change.status, change.updatedAt,
      id, ownerId, attempt.version, attempt.token).first<{ version: number }>();
  return row?.version === attempt.version + 1;
}
// 自動リライト（#6）の採用。本人の明示レビューとは区別できるよう、方針の版と自動採用の印を残す。
// 原文の版（source_hash）と公開payloadのhash（approved_hash）は、承認と同じ列に残る。

// 置換対象の版が属する文書ID。新版は同じ文書の次の版として登録する。
export async function revisionDocumentId(db: Database, ownerId: string, revisionId: string): Promise<string | null> {
  const row = await db.prepare(`SELECT document_id FROM knowledge_document_revisions WHERE id=? AND owner_id=?`)
    .bind(revisionId, ownerId).first<{ document_id: string }>();
  return row?.document_id ?? null;
}
