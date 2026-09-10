import type { Database, EmbeddingProvider } from "../types.ts";
import { approvedUnits, chunkMarkdown, normalize, searchTerms, sha256 } from "./text.ts";
import { isInjection } from "../security/request.ts";

export type ImportFact = { id: string; key: string; value: string; statement: string; aliases: string[];
  validFrom: string | null; validTo: string | null; supersedesFactId: string | null; lastVerifiedAt: string | null };
export type ImportBundle = { version: 1; ownerId: string; documentId: string; title: string; visibility: "public";
  verification: "self_reported" | "verified"; content: string; entities: string[]; facts: ImportFact[] };
export type PreparedImport = { bundle: ImportBundle; hash: string; documentKey: string; revisionId: string;
  chunks: { id: string; title: string; content: string; hash: string }[] };
export interface WritableVectorIndex {
  upsert(vectors: { id: string; values: number[]; metadata: Record<string, string> }[]): Promise<unknown>;
  getByIds(ids: string[]): Promise<{ id: string }[]>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("形式が不正です。");
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name}を確認してください。`);
  return normalize(value);
}
function list(value: unknown, name: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${name}を確認してください。`);
  return [...new Set(value.map(item => text(item, name, 100)))];
}
function date(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error("日付は有効なYYYY-MM-DDで指定してください。");
  return value;
}
function identifier(value: unknown, name: string): string {
  const result = text(value, name, 80);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(result)) throw new Error(`${name}には英数・ハイフン・アンダースコア・ピリオドを使用してください。`);
  return result;
}

export async function prepareImport(value: unknown): Promise<PreparedImport> {
  const item = object(value);
  if (item.version !== 1 || item.visibility !== "public" || !["self_reported", "verified"].includes(String(item.verification))) throw new Error("version=1、visibility=public、verificationを明示してください。");
  const content = text(item.content, "本文", 40_000);
  if (isInjection(content)) throw new Error("本文に回答制御の指示らしき記述があります。公開用の事実だけに整理してください。");
  const entities = list(item.entities ?? [], "固有名詞", 60);
  if (!Array.isArray(item.facts) || item.facts.length > 12) throw new Error("Exact Factsは文書ごとに12件までです。");
  const facts: ImportFact[] = item.facts.map(value => {
    const fact = object(value);
    const aliases = list(fact.aliases, "Factの検索語", 16);
    if (!aliases.length) throw new Error("Factの検索語が必要です。");
    const statement = text(fact.statement, "Factの承認文", 800);
    // 数字だけを切り抜かず、公開本文内の完全な段落を承認文とする。
    if (!approvedUnits(content).includes(statement)) throw new Error("Factの承認文は本文内の段落と完全一致させてください。");
    const validFrom = date(fact.validFrom), validTo = date(fact.validTo);
    if (validFrom && validTo && validFrom > validTo) throw new Error("Factの有効期間が逆転しています。");
    return { id: identifier(fact.id, "Fact ID"), key: identifier(fact.key, "Fact key"), value: text(fact.value, "Fact値", 300), statement, aliases,
      validFrom, validTo, supersedesFactId: fact.supersedesFactId == null ? null : identifier(fact.supersedesFactId, "訂正元ID"), lastVerifiedAt: date(fact.lastVerifiedAt) };
  });
  if (new Set(facts.map(fact => fact.id)).size !== facts.length) throw new Error("Fact IDが重複しています。");
  for (const fact of facts) {
    const seen = new Set([fact.id]);
    let previous = fact.supersedesFactId;
    while (previous) {
      const source = facts.find(item => item.id === previous);
      if (!source || source.key !== fact.key || seen.has(previous)) throw new Error("Factの訂正関係が不正です。同じkeyの文書内Factを指定してください。");
      seen.add(previous); previous = source.supersedesFactId;
    }
  }
  const bundle: ImportBundle = { version: 1, ownerId: identifier(item.ownerId, "ownerId"), documentId: identifier(item.documentId, "documentId"),
    title: text(item.title, "文書名", 120), visibility: "public", verification: item.verification as ImportBundle["verification"], content, entities, facts };
  const hash = await sha256(JSON.stringify(bundle));
  const documentKey = `doc_${(await sha256(`${bundle.ownerId}:${bundle.documentId}`)).slice(0, 24)}`;
  const revisionId = `rev_${hash.slice(0, 32)}`;
  const raw = chunkMarkdown(content);
  if (!raw.length || raw.length > 24) throw new Error("本文を1〜24の段落に整理してください。");
  const chunks = await Promise.all(raw.map(async (chunk, index) => ({ ...chunk, id: `${revisionId}:${index}`, hash: await sha256(chunk.content) })));
  return { bundle, hash, documentKey, revisionId, chunks };
}

type RevisionState = { approval_status: string; base_generation: number; active_revision_id: string | null; generation: number };
async function state(db: Database, prepared: PreparedImport): Promise<RevisionState | null> {
  return db.prepare(`SELECT r.approval_status,r.base_generation,d.active_revision_id,d.generation FROM knowledge_document_revisions r
    JOIN knowledge_documents d ON d.id=r.document_id WHERE r.id=? AND r.owner_id=? AND d.owner_id=?`)
    .bind(prepared.revisionId, prepared.bundle.ownerId, prepared.bundle.ownerId).first<RevisionState>();
}

export async function stageImport(db: Database, prepared: PreparedImport) {
  const { bundle, hash, documentKey, revisionId } = prepared;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO knowledge_documents(id,owner_id,title,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING").bind(documentKey, bundle.ownerId, bundle.title, now),
    db.prepare(`INSERT INTO knowledge_document_revisions(id,document_id,owner_id,content_hash,visibility,approval_status,index_state,content,base_generation,verification,created_at)
      SELECT ?,id,owner_id,?,'public','draft','not_indexed',?,generation,?,? FROM knowledge_documents WHERE id=? AND owner_id=? ON CONFLICT(id) DO NOTHING`)
      .bind(revisionId, hash, bundle.content, bundle.verification, now, documentKey, bundle.ownerId)
  ]);
  const current = await state(db, prepared);
  if (!current || ["revoked", "rejected", "superseded"].includes(current.approval_status)) throw new Error("この版は使用できません。内容を確認して新しい版を用意してください。");
  return { revisionId, hash, status: current.approval_status };
}

export async function approveImport(input: { db: Database; vector: WritableVectorIndex; embedding: EmbeddingProvider;
  prepared: PreparedImport; approvalHash: string; signal: AbortSignal; waitForVectors?: (ids: string[]) => Promise<void> }) {
  const { db, vector, embedding, prepared, signal } = input;
  const { bundle, revisionId, hash, documentKey, chunks } = prepared;
  if (input.approvalHash !== hash) throw new Error("承認ハッシュが一致しません。変更後の全文を再確認してください。");
  await stageImport(db, prepared);
  const current = (await state(db, prepared))!;
  if (current.approval_status === "approved" && current.active_revision_id === revisionId) return { revisionId, status: "already_active" };
  if (current.generation !== current.base_generation) throw new Error("確認中に現行版が変わりました。新しい文書版でやり直してください。");
  signal.throwIfAborted();
  // 承認ハッシュを確認してからEmbeddingを呼ぶ。途中失敗ではactiveを切り替えない。
  const vectors = [];
  for (const chunk of chunks) {
    signal.throwIfAborted();
    vectors.push({ id: chunk.id, values: await embedding.embed(`${chunk.title}\n${chunk.content}`, signal, "document"), metadata: { ownerId: bundle.ownerId, visibility: "public", revisionId } });
  }
  const statements = [db.prepare("UPDATE knowledge_document_revisions SET index_state='indexing' WHERE id=? AND approval_status='draft'").bind(revisionId)];
  for (const [index, chunk] of chunks.entries()) {
    statements.push(db.prepare(`INSERT INTO knowledge_chunks(id,revision_id,owner_id,title,content,content_hash,entities_json,chunk_index) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
      .bind(chunk.id, revisionId, bundle.ownerId, chunk.title, chunk.content, chunk.hash, JSON.stringify(bundle.entities), index));
    statements.push(db.prepare("DELETE FROM knowledge_fts WHERE chunk_id=?").bind(chunk.id));
    statements.push(db.prepare("INSERT INTO knowledge_fts(chunk_id,search_text) VALUES(?,?)").bind(chunk.id, searchTerms(`${chunk.title}\n${chunk.content}\n${bundle.entities.join(" ")}`).join(" ")));
  }
  for (const fact of bundle.facts) statements.push(db.prepare(`INSERT INTO exact_facts(id,owner_id,revision_id,fact_key,fact_value,statement,aliases_json,valid_from,valid_to,supersedes_fact_id,approval_status,visibility,last_verified_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,'draft','public',?) ON CONFLICT(id) DO NOTHING`).bind(`${revisionId}:${fact.id}`, bundle.ownerId, revisionId, fact.key, fact.value, fact.statement, JSON.stringify(fact.aliases), fact.validFrom, fact.validTo, fact.supersedesFactId ? `${revisionId}:${fact.supersedesFactId}` : null, fact.lastVerifiedAt));
  await db.batch(statements);
  await vector.upsert(vectors);
  const ids = chunks.map(chunk => chunk.id);
  if (input.waitForVectors) await input.waitForVectors(ids);
  else {
    let indexed = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      signal.throwIfAborted();
      const visible = new Set((await vector.getByIds(ids)).map(item => item.id));
      if (ids.every(id => visible.has(id))) { indexed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!indexed) throw new Error("Vectorizeの反映待ちです。同じハッシュで再実行してください。現行版は維持しています。");
  }
  signal.throwIfAborted();
  const now = new Date().toISOString();
  await db.batch([
    // 条件が崩れたらCHECK制約を失敗させ、batch全体をrollbackする。撤回や並行更新を巻き戻さない。
    db.prepare(`UPDATE knowledge_documents SET generation=CASE WHEN generation=? AND EXISTS(SELECT 1 FROM knowledge_document_revisions WHERE id=? AND approval_status='draft') THEN generation+1 ELSE -1 END WHERE id=? AND owner_id=?`)
      .bind(current.base_generation, revisionId, documentKey, bundle.ownerId),
    db.prepare("UPDATE knowledge_document_revisions SET approval_status='superseded' WHERE document_id=? AND approval_status='approved'").bind(documentKey),
    db.prepare("UPDATE knowledge_document_revisions SET approval_status='approved',index_state='indexed',approved_at=? WHERE id=? AND approval_status='draft'").bind(now, revisionId),
    db.prepare("UPDATE exact_facts SET approval_status='approved' WHERE revision_id=? AND approval_status='draft'").bind(revisionId),
    db.prepare("UPDATE knowledge_documents SET active_revision_id=?,title=?,updated_at=? WHERE id=? AND owner_id=?").bind(revisionId, bundle.title, now, documentKey, bundle.ownerId)
  ]);
  return { revisionId, status: "active" };
}

export async function revokeRevision(db: Database, vector: WritableVectorIndex, ownerId: string, revisionId: string) {
  if (!/^rev_[a-f0-9]{32}$/.test(revisionId)) throw new Error("Revision IDが不正です。");
  const revision = await db.prepare("SELECT document_id FROM knowledge_document_revisions WHERE id=? AND owner_id=?").bind(revisionId, ownerId).first<{ document_id: string }>();
  if (!revision) throw new Error("対象の版が見つかりません。");
  await db.batch([
    db.prepare("UPDATE knowledge_document_revisions SET approval_status='revoked',revoked_at=? WHERE id=? AND owner_id=?").bind(new Date().toISOString(), revisionId, ownerId),
    db.prepare("UPDATE exact_facts SET approval_status='revoked' WHERE revision_id=? AND owner_id=?").bind(revisionId, ownerId),
    db.prepare("UPDATE knowledge_documents SET active_revision_id=CASE WHEN active_revision_id=? THEN NULL ELSE active_revision_id END,generation=generation+1 WHERE id=? AND owner_id=?").bind(revisionId, revision.document_id, ownerId)
  ]);
  // D1で先に遮断。Vectorの削除失敗でも公開状態へ戻さない。
  const chunks = await db.prepare("SELECT id FROM knowledge_chunks WHERE revision_id=? AND owner_id=?").bind(revisionId, ownerId).all<{ id: string }>();
  try { if (chunks.results.length) await vector.deleteByIds(chunks.results.map(item => item.id)); }
  catch { return { revisionId, status: "revoked", vectorCleanupPending: true }; }
  return { revisionId, status: "revoked", vectorCleanupPending: false };
}
