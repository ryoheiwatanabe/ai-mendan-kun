import type { Database } from "../types.ts";
import type { IntakeOmitted } from "./intake.ts";

// 取り込みの管理データ（#5）。原文・下書き・省略メモは管理専用で、公開検索の経路からは読まない。
export type IntakeStatus = "draft" | "held" | "approved" | "rejected";
export type IntakeSourceRecord = { id: string; owner_id: string; title: string; raw_text: string; content_hash: string;
  replaces_revision_id: string | null; created_at: string };
export type IntakeDraftRecord = { id: string; owner_id: string; source_id: string; status: IntakeStatus; title: string;
  public_text: string; aliases_json: string; topic: string; kept_json: string; omitted_json: string; questions_json: string;
  model: string; prompt_version: string; source_hash: string; approved_revision_id: string | null; approved_hash: string | null;
  created_at: string; updated_at: string };

export type IntakeSourceView = { id: string; title: string; contentHash: string; replacesRevisionId: string | null; createdAt: string };
export type IntakeDraftView = { id: string; sourceId: string; status: IntakeStatus; title: string; publicText: string;
  aliases: string[]; topic: string; kept: string[]; omitted: IntakeOmitted[]; questions: string[]; model: string;
  promptVersion: string; approvedRevisionId: string | null; createdAt: string; updatedAt: string };

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
    createdAt: record.created_at, updatedAt: record.updated_at };
}

const sourceColumns = "id,owner_id,title,raw_text,content_hash,replaces_revision_id,created_at";
const draftColumns = "id,owner_id,source_id,status,title,public_text,aliases_json,topic,kept_json,omitted_json,questions_json,model,prompt_version,source_hash,approved_revision_id,approved_hash,created_at,updated_at";

export async function createIntakeSource(db: Database, record: IntakeSourceRecord): Promise<void> {
  await db.prepare(`INSERT INTO knowledge_intake_sources(${sourceColumns}) VALUES(?,?,?,?,?,?,?)`).bind(record.id, record.owner_id,
    record.title, record.raw_text, record.content_hash, record.replaces_revision_id, record.created_at).run();
}
export async function getIntakeSource(db: Database, ownerId: string, id: string): Promise<IntakeSourceRecord | null> {
  return db.prepare(`SELECT ${sourceColumns} FROM knowledge_intake_sources WHERE id=? AND owner_id=?`).bind(id, ownerId)
    .first<IntakeSourceRecord>();
}
export async function createIntakeDraft(db: Database, record: IntakeDraftRecord): Promise<void> {
  await db.prepare(`INSERT INTO knowledge_intake_drafts(${draftColumns}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(record.id,
    record.owner_id, record.source_id, record.status, record.title, record.public_text, record.aliases_json, record.topic,
    record.kept_json, record.omitted_json, record.questions_json, record.model, record.prompt_version, record.source_hash,
    record.approved_revision_id, record.approved_hash, record.created_at, record.updated_at).run();
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
  await db.prepare(`UPDATE knowledge_intake_drafts SET title=?,public_text=?,aliases_json=?,topic=?,status=?,updated_at=? WHERE id=? AND owner_id=?`)
    .bind(change.title, change.publicText, JSON.stringify(change.aliases), change.topic, change.status, change.updatedAt, id, ownerId).run();
}
export async function markIntakeApproved(db: Database, ownerId: string, id: string,
  approved: { revisionId: string; hash: string; updatedAt: string }): Promise<void> {
  await db.prepare(`UPDATE knowledge_intake_drafts SET status='approved',approved_revision_id=?,approved_hash=?,updated_at=? WHERE id=? AND owner_id=?`)
    .bind(approved.revisionId, approved.hash, approved.updatedAt, id, ownerId).run();
}

// 置換対象の版が属する文書ID。新版は同じ文書の次の版として登録する。
export async function revisionDocumentId(db: Database, ownerId: string, revisionId: string): Promise<string | null> {
  const row = await db.prepare(`SELECT document_id FROM knowledge_document_revisions WHERE id=? AND owner_id=?`)
    .bind(revisionId, ownerId).first<{ document_id: string }>();
  return row?.document_id ?? null;
}

