import { getAdminBindings } from "../../../../lib/runtime.ts";
import { adminAllowed } from "../../../../lib/security/admin.ts";
import { checkOrigin, PublicError } from "../../../../lib/security/request.ts";
import { adminErrorCode } from "../../../../lib/security/admin-error.ts";
import { createAnswerProvider, createEmbeddingProvider, embeddingSignature, processorNames } from "../../../../lib/ai/providers.ts";
import { assertEmbeddingSignature } from "../../../../lib/knowledge/index-config.ts";
import { approveImport, prepareImport, revokeRevision, type WritableVectorIndex } from "../../../../lib/knowledge/import.ts";
import { intakeApprovalHash, intakeBundle, intakeDocumentId, intakeInstructions, intakeLimits, intakePromptVersion,
  intakeSchema, parseIntakeResult } from "../../../../lib/knowledge/intake.ts";
import { createIntakeDraft, createIntakeSource, draftView, getIntakeDraft, getIntakeSource, intakeJsonList, listIntake,
  markIntakeApproved, revisionDocumentId, updateIntakeDraft, type IntakeDraftRecord, type IntakeStatus } from "../../../../lib/knowledge/intake-store.ts";
import { sha256 } from "../../../../lib/knowledge/text.ts";

export const dynamic = "force-dynamic";

// 取り込み（#5）。原文→公開用候補→本人の編集・承認→検索登録までを、既存の管理画面から行う。
// 候補づくりは取り込みのときだけ実行し、会話のたびには呼ばない。
const headers = { "Cache-Control": "no-store, no-transform", "X-Content-Type-Options": "nosniff" };
const MAX_BODY = 60_000;
const messages: Record<string, string> = {
  intake_input: "原文と文書名を確認してください。",
  intake_replaces: "置換対象の版を確認してください。",
  intake_draft: "下書きを確認してください。",
  intake_aliases: "検索語は1〜12件、各40字までにしてください。",
  intake_text: "公開用の本文は20〜8000字にしてください。",
  intake_title: "文書名は120字までにしてください。",
  intake_missing: "対象の下書きが見つかりません。画面を読み直してください。",
  intake_unapproved_provider: "この提供元では取り込みの候補づくりに対応していません。",
  invalid_intake_result: "公開用候補の形を確認できませんでした。もう一度お試しください。",
  intake_stale_hash: "画面の内容が保存後に変わっています。読み直してから承認してください。",
  intake_indexing: "索引の反映待ちです。少し待ってから、もう一度「承認して検索登録」を押してください。"
};

function failure(error: unknown, fallback: string, status: number): Response {
  const known = error instanceof PublicError;
  const code = known ? error.code : adminErrorCode(error);
  return Response.json({ error: { code, message: known ? error.message : messages[code] ?? fallback } },
    { status: known ? error.status : status, headers });
}
function denied(): Response {
  return Response.json({ error: { code: "ADMIN_REQUIRED", message: "管理用の鍵を確認できませんでした。鍵を入力し直してください。" } }, { status: 403, headers });
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PublicError("INVALID_INPUT", 400, messages.intake_input);
  return value as Record<string, unknown>;
}
function text(value: unknown, min: number, max: number, code: string): string {
  if (typeof value !== "string" || value.trim().length < min || value.length > max) throw new PublicError(code, 400, messages[code]);
  return value.trim();
}
function aliasList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > intakeLimits.aliases.max) throw new PublicError("intake_aliases", 400, messages.intake_aliases);
  return [...new Set(value.map(item => text(item, 1, intakeLimits.aliases.item, "intake_aliases")))];
}
// 承認の直前確認に使う。編集後の古いhashでは公開できない。
async function draftHash(record: IntakeDraftRecord): Promise<string> {
  return intakeApprovalHash({ title: record.title, publicText: record.public_text,
    aliases: intakeJsonList(record.aliases_json), topic: record.topic });
}
async function draftPayload(record: IntakeDraftRecord) {
  return { ...draftView(record), approvalHash: await draftHash(record) };
}

export async function GET(request: Request) {
  try {
    checkOrigin(request);
    const env = await getAdminBindings();
    if (!adminAllowed(request, env)) return denied();
    const ownerId = env.OWNER_ID || "default";
    const listed = await listIntake(env.DB, ownerId);
    // 原文は管理画面（この応答）にだけ返し、公開検索の経路へは渡さない。
    const sources = await Promise.all(listed.sources.map(async source => {
      const full = await getIntakeSource(env.DB, ownerId, source.id);
      return { ...source, rawText: full?.raw_text ?? "" };
    }));
    const drafts = await Promise.all(listed.drafts.map(async draft => {
      const record = await getIntakeDraft(env.DB, ownerId, draft.id);
      return record ? draftPayload(record) : draft;
    }));
    let label = "";
    try { label = processorNames(env); } catch { label = ""; }
    // 置換先の候補として、現在公開中の文書（見出しと版）だけを返す。本文は返さない。
    const documents = await env.DB.prepare(`SELECT d.id AS documentId,r.id AS revisionId,d.title AS title
      FROM knowledge_documents d JOIN knowledge_document_revisions r ON r.id=d.active_revision_id
      WHERE d.owner_id=? AND r.owner_id=d.owner_id AND r.approval_status='approved' AND r.visibility='public' AND r.index_state='indexed'
      ORDER BY d.updated_at DESC LIMIT 50`).bind(ownerId).all<{ documentId: string; revisionId: string; title: string }>();
    return Response.json({ sources, drafts, publicDocuments: documents.results,
      provider: { label, model: env.ANSWER_MODEL ?? "", promptVersion: intakePromptVersion }, limits: intakeLimits }, { headers });
  } catch (error) { return failure(error, "管理データを読み込めませんでした。時間をおいてお試しください。", 503); }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const env = await getAdminBindings();
    if (!adminAllowed(request, env)) return denied();
    if (!request.headers.get("content-type")?.includes("application/json")) throw new PublicError("INVALID_INPUT", 400, messages.intake_input);
    const body = await request.text();
    if (body.length > MAX_BODY) throw new PublicError("INVALID_INPUT", 413, "入力が大きすぎます。原文を分けてください。");
    let input: Record<string, unknown>;
    try { input = record(JSON.parse(body)); } catch { throw new PublicError("INVALID_INPUT", 400, messages.intake_input); }
    const ownerId = env.OWNER_ID || "default";
    const action = typeof input.action === "string" ? input.action : "";
    const now = new Date().toISOString();

    if (action === "prepare") {
      const title = text(input.title, 1, intakeLimits.title, "intake_title");
      const rawText = text(input.rawText, intakeLimits.rawText.min, intakeLimits.rawText.max, "intake_input");
      const replacesRevisionId = input.replacesRevisionId === undefined || input.replacesRevisionId === "" ? null
        : text(input.replacesRevisionId, 1, 80, "intake_replaces");
      if (replacesRevisionId && !/^rev_[a-f0-9]{32}$/.test(replacesRevisionId)) throw new PublicError("intake_replaces", 400, messages.intake_replaces);
      if (replacesRevisionId && !await revisionDocumentId(env.DB, ownerId, replacesRevisionId)) throw new PublicError("intake_replaces", 400, messages.intake_replaces);
      const provider = createAnswerProvider(env);
      if (!provider.generateStructured) throw new PublicError("intake_unapproved_provider", 503, messages.intake_unapproved_provider);
      const sourceId = crypto.randomUUID(), draftId = crypto.randomUUID();
      const sourceHash = await sha256(rawText);
      const generated = await provider.generateStructured({ system: intakeInstructions,
        payload: { title, source: rawText }, schema: intakeSchema }, AbortSignal.timeout(60_000));
      const candidate = parseIntakeResult(generated.value);
      await createIntakeSource(env.DB, { id: sourceId, owner_id: ownerId, title, raw_text: rawText, content_hash: sourceHash,
        replaces_revision_id: replacesRevisionId, created_at: now });
      await createIntakeDraft(env.DB, { id: draftId, owner_id: ownerId, source_id: sourceId, status: "draft", title,
        public_text: candidate.publicText, aliases_json: JSON.stringify(candidate.aliases), topic: candidate.topic,
        kept_json: JSON.stringify(candidate.kept), omitted_json: JSON.stringify(candidate.omitted),
        questions_json: JSON.stringify(candidate.questions), model: env.ANSWER_MODEL ?? "", prompt_version: intakePromptVersion,
        source_hash: sourceHash, approved_revision_id: null, approved_hash: null, created_at: now, updated_at: now });
      const draft = await getIntakeDraft(env.DB, ownerId, draftId);
      if (!draft) throw new PublicError("intake_missing", 500, messages.intake_missing);
      return Response.json({ draft: await draftPayload(draft), usage: generated.usage,
        provider: { model: env.ANSWER_MODEL ?? "", promptVersion: intakePromptVersion } }, { headers });
    }

    if (action === "save" || action === "hold" || action === "reject") {
      const draftId = text(input.draftId, 1, 80, "intake_draft");
      const draft = await getIntakeDraft(env.DB, ownerId, draftId);
      if (!draft) throw new PublicError("intake_missing", 404, messages.intake_missing);
      if (draft.status === "approved") throw new PublicError("intake_draft", 409, "登録済みの下書きは変更できません。新しく候補を作ってください。");
      if (action === "reject") {
        await updateIntakeDraft(env.DB, ownerId, draftId, { title: draft.title, publicText: draft.public_text,
          aliases: intakeJsonList(draft.aliases_json), topic: draft.topic, status: "rejected", updatedAt: now });
      } else {
        const title = text(input.title, 1, intakeLimits.title, "intake_title");
        const publicText = text(input.publicText, intakeLimits.publicText.min, intakeLimits.publicText.max, "intake_text");
        const aliases = aliasList(input.aliases);
        if (aliases.length < intakeLimits.aliases.min) throw new PublicError("intake_aliases", 400, messages.intake_aliases);
        const topic = input.topic === undefined ? draft.topic : text(input.topic, 0, intakeLimits.topic, "intake_draft");
        const status: IntakeStatus = action === "hold" ? "held" : "draft";
        await updateIntakeDraft(env.DB, ownerId, draftId, { title, publicText, aliases, topic, status, updatedAt: now });
      }
      const updated = await getIntakeDraft(env.DB, ownerId, draftId);
      if (!updated) throw new PublicError("intake_missing", 500, messages.intake_missing);
      return Response.json({ draft: await draftPayload(updated) }, { headers });
    }

    if (action === "approve") {
      const draftId = text(input.draftId, 1, 80, "intake_draft");
      const draft = await getIntakeDraft(env.DB, ownerId, draftId);
      if (!draft) throw new PublicError("intake_missing", 404, messages.intake_missing);
      if (draft.status === "approved") throw new PublicError("intake_draft", 409, "この下書きは登録済みです。");
      const submitted = typeof input.approvalHash === "string" ? input.approvalHash : "";
      if (!submitted || submitted !== await draftHash(draft)) throw new PublicError("intake_stale_hash", 409, messages.intake_stale_hash);
      const source = await getIntakeSource(env.DB, ownerId, draft.source_id);
      const replacesRevisionId = source?.replaces_revision_id ?? null;
      const documentId = replacesRevisionId ? await revisionDocumentId(env.DB, ownerId, replacesRevisionId) : intakeDocumentId(draft.id);
      if (!documentId) throw new PublicError("intake_replaces", 400, messages.intake_replaces);
      // 公開exportは、公開してよいフィールドだけを組み立てる（原文・省略メモは渡さない）。
      const prepared = await prepareImport(intakeBundle({ ownerId, documentId, title: draft.title,
        publicText: draft.public_text, aliases: intakeJsonList(draft.aliases_json) }));
      const embedding = createEmbeddingProvider(env);
      await assertEmbeddingSignature(env.DB, ownerId, embeddingSignature(env), true);
      // 実行時のバインディングは書き込みも持つ。型は読み取り用の面だけを公開している。
      const vector = env.VECTORIZE as unknown as WritableVectorIndex;
      let approved;
      try {
        approved = await approveImport({ db: env.DB, vector, embedding, prepared,
          approvalHash: prepared.hash, signal: AbortSignal.timeout(120_000) });
      } catch (error) {
        // 索引の反映待ちは失敗ではなく再試行の案内。現行版は変わっていない。
        if (error instanceof Error && error.message.includes("Vectorizeの反映待ち"))
          throw new PublicError("intake_indexing", 503, messages.intake_indexing);
        throw error;
      }
      if (approved.status === "failed") throw new PublicError("intake_failed", 500, "検索への登録に失敗しました。時間をおいてもう一度お試しください。");
      // 新しい公開版の承認後にだけ、本人が選んだ旧版を撤回する。
      let replaced = false;
      if (replacesRevisionId) { await revokeRevision(env.DB, vector, ownerId, replacesRevisionId); replaced = true; }
      await markIntakeApproved(env.DB, ownerId, draftId, { revisionId: prepared.revisionId, hash: prepared.hash, updatedAt: now });
      const updated = await getIntakeDraft(env.DB, ownerId, draftId);
      return Response.json({ revisionId: prepared.revisionId, documentId, replacesRevisionId, replaced,
        draft: updated ? await draftPayload(updated) : null }, { headers });
    }

    throw new PublicError("INVALID_INPUT", 400, "操作を確認してください。");
  } catch (error) { return failure(error, "管理処理を続けられませんでした。時間をおいてお試しください。", 503); }
}
