import { getAdminBindings } from "../../../../lib/runtime.ts";
import { adminAllowed } from "../../../../lib/security/admin.ts";
import { checkOrigin, PublicError } from "../../../../lib/security/request.ts";
import { adminErrorCode } from "../../../../lib/security/admin-error.ts";
import { createAnswerProvider, createEmbeddingProvider, embeddingSignature, processorNames } from "../../../../lib/ai/providers.ts";
import { assertEmbeddingSignature } from "../../../../lib/knowledge/index-config.ts";
import { approveImport, prepareImport, revokeRevision, type WritableVectorIndex } from "../../../../lib/knowledge/import.ts";
import { intakeApprovalHash, intakeAutoAdoptable, intakeAutoPolicyVersion, intakeBundle, intakeDocumentId,
  intakeInstructions, intakeIntroducedNumbers, intakeLimits, intakeMeaningAccepted, intakeMeaningAxes,
  intakeMeaningQuestion, intakePromptVersion, intakeReviewAccepted, intakeReviewQuestions, intakeReviewState,
  intakeSchema, intakeVisibleSource, parseIntakeResult, type IntakeCandidate } from "../../../../lib/knowledge/intake.ts";
import { claimExpiredIntakeDraft, createIntakeDraft, createIntakeSource, draftView, getIntakeDraft, getIntakeSource,
  intakeJsonList, intakeJsonOmitted, listIntake, markIntakeApproved, revisionDocumentId, updateIntakeCandidate,
  updateIntakeDraft, type IntakeDraftRecord, type IntakeStatus } from "../../../../lib/knowledge/intake-store.ts";
import { sha256 } from "../../../../lib/knowledge/text.ts";
import { createJevPipeline } from "../../../../lib/answer/pipeline-config.ts";
import { assertAllowedContent, getContentExclusions, type ContentExclusionPolicy } from "../../../../lib/security/content-exclusions.ts";
import type { Bindings, Evidence } from "../../../../lib/types.ts";

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
  intake_indexing: "索引の反映待ちです。少し待ってから、もう一度「承認して検索登録」を押してください。",
  intake_storage_consent: "原文の保存先と送信先を確認し、同意のチェックを入れてください。",
  intake_provider_unknown: "変換の送信先（提供元）を確認できませんでした。設定を確認してから、もう一度お試しください。",
  intake_stale_version: "別の画面で保存されたため、内容が変わっています。読み直してから、もう一度確認してください。",
  intake_replaces_changed: "置換対象の版が更新または撤回されています。読み直して、対象を選び直してください。",
  intake_facts_loss: "置換対象には引き継がれないFactがあります。内容を確認して、了解のうえで承認してください。"
  , intake_target_changed: "最終確認の対象（新規／置換先）が、保存済みの内容と一致しません。読み直してから承認してください。"
  , intake_target_unresolved: "置換先の版を確認できません。読み直して、対象を選び直してください。"
  , intake_public_target: "この原文を公開対象として取り込むことを、操作で明示してください。"
  , intake_auto_held: "自動では採用せず、非公開のまま保留しました。内容を確認してから承認してください。"
  , intake_excluded_source: "非表示に指定された章・段落を除外した結果、公開できる本文が残りませんでした。原文と対象を見直してください。"
  , intake_excluded_title: "文書名が非表示の指定に当たります。公開できる見出しに変えてから、もう一度お試しください。"
  , intake_request_conflict: "同じ操作IDで内容が変わっています。画面を読み直して、もう一度お試しください。"
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
// 保存済みの下書きに紐づく公開対象。画面の作成フォームではなく、これだけを最終確認に使う。
// 置換先が現行版でないなど解決できない場合は unresolved とし、新規として扱わない。
export type IntakeTarget = { kind: "new" | "replace" | "unresolved"; documentId?: string; revisionId?: string;
  title?: string; facts?: number; chunks?: number };
async function draftTarget(db: Bindings["DB"], ownerId: string, sourceId: string, approvedRevisionId: string | null): Promise<IntakeTarget> {
  const source = await getIntakeSource(db, ownerId, sourceId);
  if (!source) return { kind: "unresolved" };
  // 承認済みなら、その版が属する文書の現行版を対象にする（元の置換先が古くなっていても解決できる）。
  // 撤回済みなどで現行版が無いときは unresolved のままにし、古い版を勝手に復活させない。
  if (approvedRevisionId) {
    const documentId = await revisionDocumentId(db, ownerId, approvedRevisionId);
    if (!documentId) return { kind: "unresolved", revisionId: approvedRevisionId };
    const current = await db.prepare(`SELECT d.id AS documentId,r.id AS revisionId,d.title AS title,
        (SELECT COUNT(*) FROM exact_facts f WHERE f.revision_id=r.id AND f.approval_status='approved') AS facts,
        (SELECT COUNT(*) FROM knowledge_chunks c WHERE c.revision_id=r.id) AS chunks
      FROM knowledge_documents d JOIN knowledge_document_revisions r ON r.id=d.active_revision_id AND r.document_id=d.id
      WHERE d.owner_id=? AND d.id=? AND r.owner_id=? AND r.approval_status='approved' AND r.visibility='public'`)
      .bind(ownerId, documentId, ownerId)
      .first<{ documentId: string; revisionId: string; title: string; facts: number; chunks: number }>();
    if (!current) return { kind: "unresolved", revisionId: approvedRevisionId };
    return { kind: "replace", documentId: current.documentId, revisionId: current.revisionId, title: current.title,
      facts: Number(current.facts) || 0, chunks: Number(current.chunks) || 0 };
  }
  const replacesRevisionId = source.replaces_revision_id;
  if (!replacesRevisionId) return { kind: "new" };
  const row = await db.prepare(`SELECT d.id AS documentId,r.id AS revisionId,d.title AS title,
      (SELECT COUNT(*) FROM exact_facts f WHERE f.revision_id=r.id AND f.approval_status='approved') AS facts,
      (SELECT COUNT(*) FROM knowledge_chunks c WHERE c.revision_id=r.id) AS chunks
    FROM knowledge_documents d JOIN knowledge_document_revisions r ON r.id=d.active_revision_id AND r.document_id=d.id
    WHERE d.owner_id=? AND r.id=? AND r.owner_id=?`)
    .bind(ownerId, replacesRevisionId, ownerId)
    .first<{ documentId: string; revisionId: string; title: string; facts: number; chunks: number }>();
  if (!row) return { kind: "unresolved", revisionId: replacesRevisionId };
  return { kind: "replace", documentId: row.documentId, revisionId: row.revisionId, title: row.title,
    facts: Number(row.facts) || 0, chunks: Number(row.chunks) || 0 };
}
async function draftPayload(db: Bindings["DB"], ownerId: string, record: IntakeDraftRecord) {
  return { ...draftView(record), approvalHash: await draftHash(record),
    target: await draftTarget(db, ownerId, record.source_id, record.approved_revision_id) };
}
// 除外の設定版（規則IDのみ）。実値は返さない。設定不備のときは空にし、公開の実行時に拒否する。
function exclusionRevision(env: Bindings): string {
  try { return getContentExclusions(env).revision; } catch { return ""; }
}
// 取り込み時の意味保持の確認先（JEV）。同意の表示と、自動採用の可否に使う。
function meaningCheck(env: Bindings): { available: boolean; label: string } {
  try {
    const pipeline = createJevPipeline(env);
    if (!pipeline) return { available: false, label: "" };
    return { available: true, label: pipeline.settings.judge.backend === "workers-ai"
      ? "Cloudflare Workers AI（typesafe/jev）" : "TypeSafe公式HTTP（api.typesafe.ai）" };
  } catch { return { available: false, label: "" }; }
}
// 取り込み時の意味保持の判定（#6）。共有の evaluate があればそれを使い、無ければ既存の点検で同じ観点を見る。
// 判定できないときは採用せず保留する（安全側）。
async function intakeMeaningHeld(env: Bindings, title: string, source: string, candidate: string, signal: AbortSignal): Promise<string | null> {
  let judge;
  try { judge = createJevPipeline(env)?.judge; } catch { judge = undefined; }
  if (!judge) return "meaning_unavailable";
  try {
    if (judge.evaluate) {
      const parsed = await judge.evaluate("intake_review", intakeReviewQuestions, intakeReviewState(title, source, candidate), signal);
      const scores = Object.fromEntries(Object.entries(parsed.answers)
        .flatMap(([id, answer]) => answer.type === "noul" ? [[id, answer.value]] : []));
      return intakeReviewAccepted(scores) ? null : "meaning_changed";
    }
    const evidence: Evidence = { id: "intake-source", revisionId: "intake-source", documentId: "intake-source",
      title, content: source, contentHash: "", entities: [], kind: "chunk", rank: 1 };
    const assessment = await judge.check({ question: intakeMeaningQuestion, history: [], evidence: [evidence],
      candidate, axes: intakeMeaningAxes }, signal);
    return intakeMeaningAccepted(assessment.scores) ? null : "meaning_changed";
  } catch { return "meaning_unavailable"; }
}

// 保存済みの下書きから、生成済みの候補を復元する（再開のときにLLMで作り直さないため）。
function candidateFromDraft(record: IntakeDraftRecord): IntakeCandidate {
  return { publicText: record.public_text, aliases: intakeJsonList(record.aliases_json), topic: record.topic,
    kept: intakeJsonList(record.kept_json), omitted: intakeJsonOmitted(record.omitted_json),
    questions: intakeJsonList(record.questions_json) };
}

// 生成中・点検中に本人の操作が入った場合。公開せず、いまの下書きの状態を返す（後操作を優先）。
async function staleAuto(env: Bindings, ownerId: string, draftId: string): Promise<Response> {
  const record = await getIntakeDraft(env.DB, ownerId, draftId);
  return Response.json({ draft: record ? await draftPayload(env.DB, ownerId, record) : null, reused: true,
    autoAdopted: false, held: record?.status === "held", reason: "manual_review" }, { headers });
}

// 自動採用の後半（点検と公開・保留）。生成が終わった候補に対して実行する。
// 再送で再開するときも、この末尾から続ける（LLMでは作り直さない）。
async function finalizeAuto(env: Bindings, ownerId: string, draft: IntakeDraftRecord, candidate: IntakeCandidate,
  title: string, visibleSource: string, policy: ContentExclusionPolicy, now: string,
  attempt: { version: number; token: string }, usage?: { input: number; output: number }): Promise<Response> {
  // この試行の候補を保存する。生成中に本人が保存・却下・取消していれば、ここで外れる（後操作を優先）。
  const saved = await updateIntakeCandidate(env.DB, ownerId, draft.id, attempt, { title, publicText: candidate.publicText,
    aliases: candidate.aliases, topic: candidate.topic, kept: candidate.kept, omitted: candidate.omitted,
    questions: candidate.questions, status: "draft", updatedAt: now });
  if (!saved) return await staleAuto(env, ownerId, draft.id);
  const current = { version: attempt.version + 1, token: attempt.token };
  const target = await draftTarget(env.DB, ownerId, draft.source_id, null);
  // 包括許可を超える箇所だけを例外として残す。要確認（事実の衝突・意味変更・新しい公開範囲）、
  // 非表示指定の残存、機械的な数値の追加、意味保持の判定不能、引き継がれないFactは、公開せず保留する。
  let heldReason = "";
  if (policy.matches(title)) heldReason = "excluded_title";
  else if (target.kind === "unresolved") heldReason = "intake_target_unresolved";
  else if (target.kind === "replace" && (target.facts ?? 0) > 0) heldReason = "intake_facts_loss";
  else if (!intakeAutoAdoptable(candidate)) heldReason = "needs_review";
  else if (intakeIntroducedNumbers(visibleSource, candidate.publicText).length) heldReason = "numbers_introduced";
  else {
    try { assertAllowedContent({ title, publicText: candidate.publicText, aliases: candidate.aliases }, policy); }
    catch { heldReason = "excluded_content"; }
    // 意味・公開範囲・数値/主体/時期/否定・実績の創作・弱みの消失を、取り込み時に1回だけ確認する。
    if (!heldReason) heldReason = await intakeMeaningHeld(env, title, visibleSource, candidate.publicText, AbortSignal.timeout(30_000)) ?? "";
  }
  if (heldReason) {
    const heldSaved = await updateIntakeCandidate(env.DB, ownerId, draft.id, current, { title, publicText: candidate.publicText,
      aliases: candidate.aliases, topic: candidate.topic, kept: candidate.kept, omitted: candidate.omitted,
      questions: candidate.questions, status: "held", updatedAt: now });
    if (!heldSaved) return await staleAuto(env, ownerId, draft.id);
    const held = await getIntakeDraft(env.DB, ownerId, draft.id);
    return Response.json({ draft: held ? await draftPayload(env.DB, ownerId, held) : null, autoAdopted: false,
      held: true, reason: heldReason, exclusionRevision: policy.revision, usage }, { headers });
  }
  // 意味を保つ通常のリライトは、表現ごとの承認を挟まず既存の承認・置換経路へ進める。
  const documentId = intakeDocumentId(draft.id);
  const prepared = await prepareImport(intakeBundle({ ownerId, documentId, title,
    publicText: candidate.publicText, aliases: candidate.aliases }),
    { ...(target.kind === "replace" ? { documentKey: target.documentId } : {}), policy });
  const embedding = createEmbeddingProvider(env);
  await assertEmbeddingSignature(env.DB, ownerId, embeddingSignature(env), true);
  const vector = env.VECTORIZE as unknown as WritableVectorIndex;
  let approved;
  try {
    approved = await approveImport({ db: env.DB, vector, embedding, prepared,
      approvalHash: prepared.hash, signal: AbortSignal.timeout(120_000), policy,
      // 自動採用の記録は、公開へ切り替えるのと同じトランザクションで残す。
      attempt: { draftId: draft.id, version: current.version, token: current.token,
        approval: { revisionId: prepared.revisionId, hash: prepared.hash, policyVersion: intakeAutoPolicyVersion, updatedAt: now } } });
  } catch (error) {
    // 公開の直前に本人の操作が入っていた場合は、公開せずに現在の状態を返す。
    if (error instanceof Error && error.message === "intake_attempt_stale") return await staleAuto(env, ownerId, draft.id);
    // 索引の反映待ちは失敗ではなく再試行の案内。現行版は変わっていない。
    if (error instanceof Error && error.message.includes("Vectorizeの反映待ち"))
      throw new PublicError("intake_indexing", 503, messages.intake_indexing);
    throw error;
  }
  if (approved.status === "failed") throw new PublicError("intake_failed", 500, "検索への登録に失敗しました。時間をおいてもう一度お試しください。");
  let replaced = false, vectorCleanupPending = false;
  if (target.kind === "replace" && target.revisionId) {
    const revoked = await revokeRevision(env.DB, vector, ownerId, target.revisionId);
    replaced = true; vectorCleanupPending = revoked.vectorCleanupPending;
  }
  // 自動採用は、編集方針の版・原文の版（source_hash）・公開payloadのhashとともに記録する。
  const updated = await getIntakeDraft(env.DB, ownerId, draft.id);
  return Response.json({ revisionId: prepared.revisionId, documentId, documentKey: prepared.documentKey,
    replacesRevisionId: target.kind === "replace" ? target.revisionId : null, replaced, vectorCleanupPending, lostFacts: 0,
    autoAdopted: true, held: false, exclusionRevision: policy.revision,
    published: { title, publicText: candidate.publicText, aliases: candidate.aliases, topic: candidate.topic },
    draft: updated ? await draftPayload(env.DB, ownerId, updated) : null, usage }, { headers });
}

// 同じrequestIdの再送。内容を照合し、未完了なら既存の点検・公開の末尾から再開する（LLMでは作り直さない）。
async function resumeAuto(env: Bindings, ownerId: string, draft: IntakeDraftRecord,
  request: { title: string; sourceHash: string; replacesRevisionId: string | null; policy: ContentExclusionPolicy },
  now: string): Promise<Response | null> {
  const source = await getIntakeSource(env.DB, ownerId, draft.source_id);
  // 同じIDで内容が違うときは、黙って使い回さない。
  if (!source || source.content_hash !== request.sourceHash || source.title !== request.title
    || (source.replaces_revision_id ?? null) !== request.replacesRevisionId)
    return Response.json({ error: { code: "intake_request_conflict", message: messages.intake_request_conflict } }, { status: 409, headers });
  if (draft.status === "approved")
    return Response.json({ draft: await draftPayload(env.DB, ownerId, draft), reused: true,
      autoAdopted: (draft.auto_adopted ?? 0) === 1, held: false }, { headers });
  // 保留の終端、本人の手動保存・却下・取消のあとは、古い再送で公開しない（後操作を上書きしない）。
  const autoAttempt = (draft.auto_policy_version ?? "").startsWith(intakeAutoPolicyVersion);
  if (draft.status !== "draft" || !autoAttempt)
    return Response.json({ draft: await draftPayload(env.DB, ownerId, draft), reused: true, autoAdopted: false,
      held: draft.status === "held", reason: draft.status === "held" ? "held_terminal" : "manual_review" }, { headers });
  // 生成がまだ終わっていない確保は、その場では作り直さない（同時の二重生成を避ける）。
  if (!draft.public_text.trim()) {
    const expired = Date.now() - Date.parse(draft.updated_at) > 120_000;
    // 期限を過ぎた確保は、1つの要求だけが引き継いで同じIDのまま作り直す。
    if (expired) {
      const token = intakeAutoPolicyVersion + ":" + crypto.randomUUID();
      const won = await claimExpiredIntakeDraft(env.DB, ownerId, draft.id, draft.version ?? 1, token, now);
      if (won) return null;
    }
    return Response.json({ draft: await draftPayload(env.DB, ownerId, draft), reused: true, autoAdopted: false, held: false,
      pending: true, reason: "generation_incomplete" }, { headers });
  }
  // 候補はあるので、LLMで作り直さず、点検と公開の末尾から再開する。
  return await finalizeAuto(env, ownerId, draft, candidateFromDraft(draft), request.title,
    intakeVisibleSource(source.raw_text, request.policy), request.policy, now,
    { version: draft.version ?? 1, token: draft.auto_policy_version ?? "" });
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
      return record ? draftPayload(env.DB, ownerId, record) : draft;
    }));
    let label = "";
    try { label = processorNames(env); } catch { label = ""; }
    // 置換先の候補として、現在公開中の文書（見出し・版・引き継げないFact数）だけを返す。本文は返さない。
    const documents = await env.DB.prepare(`SELECT d.id AS documentId,r.id AS revisionId,d.title AS title,
        (SELECT COUNT(*) FROM exact_facts f WHERE f.revision_id=r.id AND f.approval_status='approved') AS facts,
        (SELECT COUNT(*) FROM knowledge_chunks c WHERE c.revision_id=r.id) AS chunks
      FROM knowledge_documents d JOIN knowledge_document_revisions r ON r.id=d.active_revision_id
      WHERE d.owner_id=? AND r.owner_id=d.owner_id AND r.approval_status='approved' AND r.visibility='public' AND r.index_state='indexed'
      ORDER BY d.updated_at DESC LIMIT 50`).bind(ownerId).all<{ documentId: string; revisionId: string; title: string; facts: number; chunks: number }>();
    // 原文はCloudflareの管理専用テーブルへ保存する。公開検索に出さないことと、クラウドへ保存しないことは別。
    const destination = { label: env.INTAKE_DESTINATION_LABEL
      ?? "本番と同じD1データベース・Vectorize索引（公開中のAI面談くんの回答にも反映されます）",
      rawStorage: "原文はCloudflareの管理専用テーブル（knowledge_intake_sources）へ保存されます。公開検索には出ません。" };
    const providerReady = label.trim().length > 0;
    return Response.json({ sources, drafts, publicDocuments: documents.results, destination, providerReady,
      provider: { label, model: env.ANSWER_MODEL ?? "", promptVersion: intakePromptVersion }, limits: intakeLimits,
      exclusionRevision: exclusionRevision(env), autoPolicyVersion: intakeAutoPolicyVersion, meaningCheck: meaningCheck(env) }, { headers });
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
      // 原文は管理専用テーブルへ保存し、変換のため提供元へ送る。同意なしでは実行しない。
      if (input.acknowledgeStorage !== true) throw new PublicError("intake_storage_consent", 400, messages.intake_storage_consent);
      // 送信先（提供元）の説明を出せないままでは実行しない。
      let providerLabel = "";
      try { providerLabel = processorNames(env); } catch { providerLabel = ""; }
      if (!providerLabel.trim()) throw new PublicError("intake_provider_unknown", 503, messages.intake_provider_unknown);
      const replacesRevisionId = input.replacesRevisionId === undefined || input.replacesRevisionId === "" ? null
        : text(input.replacesRevisionId, 1, 80, "intake_replaces");
      if (replacesRevisionId && !/^rev_[a-f0-9]{32}$/.test(replacesRevisionId)) throw new PublicError("intake_replaces", 400, messages.intake_replaces);
      if (replacesRevisionId && !await revisionDocumentId(env.DB, ownerId, replacesRevisionId)) throw new PublicError("intake_replaces", 400, messages.intake_replaces);
      const provider = createAnswerProvider(env);
      if (!provider.generateStructured) throw new PublicError("intake_unapproved_provider", 503, messages.intake_unapproved_provider);
      // 非表示の指定は、外部の変換へ送る前に必ず確認する。指定に当たる内容は送らない（原文も保存しない）。
      const policy = getContentExclusions(env);
      if (policy.matches(title)) throw new PublicError("intake_excluded_title", 422, messages.intake_excluded_title);
      const visibleSource = intakeVisibleSource(rawText, policy);
      if (visibleSource.length < intakeLimits.rawText.min) throw new PublicError("intake_excluded_source", 422, messages.intake_excluded_source);
      const sourceId = crypto.randomUUID(), draftId = crypto.randomUUID();
      const sourceHash = await sha256(rawText);
      const generated = await provider.generateStructured({ system: intakeInstructions,
        payload: { title, source: visibleSource }, schema: intakeSchema }, AbortSignal.timeout(60_000));
      const candidate = parseIntakeResult(generated.value);
      await createIntakeSource(env.DB, { id: sourceId, owner_id: ownerId, title, raw_text: rawText, content_hash: sourceHash,
        replaces_revision_id: replacesRevisionId, created_at: now });
      await createIntakeDraft(env.DB, { id: draftId, owner_id: ownerId, source_id: sourceId, status: "draft", title,
        public_text: candidate.publicText, aliases_json: JSON.stringify(candidate.aliases), topic: candidate.topic,
        kept_json: JSON.stringify(candidate.kept), omitted_json: JSON.stringify(candidate.omitted),
        questions_json: JSON.stringify(candidate.questions), model: env.ANSWER_MODEL ?? "", prompt_version: intakePromptVersion,
        source_hash: sourceHash, approved_revision_id: null, approved_hash: null, auto_policy_version: "", auto_adopted: 0,
        created_at: now, updated_at: now, version: 1 });
      const draft = await getIntakeDraft(env.DB, ownerId, draftId);
      if (!draft) throw new PublicError("intake_missing", 500, messages.intake_missing);
      return Response.json({ draft: await draftPayload(env.DB, ownerId, draft), usage: generated.usage,
        provider: { model: env.ANSWER_MODEL ?? "", promptVersion: intakePromptVersion } }, { headers });
    }

    if (action === "auto") {
      // #6: 本人が取り込み操作で「公開対象」として明示し、原文の保存先と送信先へ同意した場合だけ、
      // 意味を保つ面談向けリライトを自動適用する。表現ごとの承認は挟まない。
      const title = text(input.title, 1, intakeLimits.title, "intake_title");
      const rawText = text(input.rawText, intakeLimits.rawText.min, intakeLimits.rawText.max, "intake_input");
      if (input.acknowledgeStorage !== true) throw new PublicError("intake_storage_consent", 400, messages.intake_storage_consent);
      // 公開対象の指定と、表現ごとの承認は別。操作で明示されていなければ実行しない。
      if (input.publicTarget !== true) throw new PublicError("intake_public_target", 400, messages.intake_public_target);
      let providerLabel = "";
      try { providerLabel = processorNames(env); } catch { providerLabel = ""; }
      if (!providerLabel.trim()) throw new PublicError("intake_provider_unknown", 503, messages.intake_provider_unknown);
      const replacesRevisionId = input.replacesRevisionId === undefined || input.replacesRevisionId === "" ? null
        : text(input.replacesRevisionId, 1, 80, "intake_replaces");
      if (replacesRevisionId && !/^rev_[a-f0-9]{32}$/.test(replacesRevisionId)) throw new PublicError("intake_replaces", 400, messages.intake_replaces);
      if (replacesRevisionId && !await revisionDocumentId(env.DB, ownerId, replacesRevisionId)) throw new PublicError("intake_replaces", 400, messages.intake_replaces);
      const provider = createAnswerProvider(env);
      if (!provider.generateStructured) throw new PublicError("intake_unapproved_provider", 503, messages.intake_unapproved_provider);
      // 非表示の指定は、公開exportの前に必ず読む。設定不備ならここで止める（安全側）。
      const policy = getContentExclusions(env);
      const sourceHash = await sha256(rawText);
      // 再試行で重複しないよう、画面が発行したrequestIdを下書きIDに使う。
      const requestId = typeof input.requestId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.requestId)
        ? input.requestId : crypto.randomUUID();
      // 同じIDの再送は、内容を照合し、未完了なら点検・公開の末尾から再開する。
      const existing = await getIntakeDraft(env.DB, ownerId, requestId);
      const resumed = existing ? await resumeAuto(env, ownerId, existing, { title, sourceHash, replacesRevisionId, policy }, now) : null;
      if (resumed) return resumed;
      // 非表示の指定に触れる章・段落は、生成へ送る前に丸ごと外す。名前だけを消して話を続けない。
      const visibleSource = intakeVisibleSource(rawText, policy);
      // 文書名が指定に当たるときは、外部の変換へ送らない（保留して管理画面で確認する）。
      const titleExcluded = policy.matches(title);
      const tooShort = visibleSource.length < intakeLimits.rawText.min;
      const sourceId = crypto.randomUUID();
      // この試行のtoken。生成中・点検中に本人の操作が入った場合と区別するために使う。
      const token = intakeAutoPolicyVersion + ":" + crypto.randomUUID();
      // 生成の前に原文と下書きを確保し、同時に来た同じ操作の二重生成を防ぐ（汎用のqueueは作らない）。
      if (!existing) try {
        await createIntakeSource(env.DB, { id: sourceId, owner_id: ownerId, title, raw_text: rawText, content_hash: sourceHash,
          replaces_revision_id: replacesRevisionId, created_at: now });
        await createIntakeDraft(env.DB, { id: requestId, owner_id: ownerId, source_id: sourceId, status: "draft", title,
          public_text: "", aliases_json: "[]", topic: "", kept_json: "[]", omitted_json: "[]",
          questions_json: JSON.stringify([titleExcluded ? messages.intake_excluded_title : messages.intake_excluded_source]),
          model: env.ANSWER_MODEL ?? "", prompt_version: intakePromptVersion, source_hash: sourceHash,
          approved_revision_id: null, approved_hash: null, auto_policy_version: token, auto_adopted: 0,
          created_at: now, updated_at: now, version: 1 });
      } catch (error) {
        // 先に進んだ同じ操作があれば、確保済みの下書きを読み直して再開する。
        const claimed = await getIntakeDraft(env.DB, ownerId, requestId);
        if (claimed) return (await resumeAuto(env, ownerId, claimed, { title, sourceHash, replacesRevisionId, policy }, now))
          ?? Response.json({ draft: await draftPayload(env.DB, ownerId, claimed), reused: true, autoAdopted: false, held: false,
            pending: true, reason: "generation_incomplete" }, { headers });
        throw error;
      }
      // 生成を始める時点の版とtokenを固定する（120秒の再取得のあとは、新しい版を使う）。
      const attemptDraft = await getIntakeDraft(env.DB, ownerId, requestId);
      if (!attemptDraft) throw new PublicError("intake_missing", 500, messages.intake_missing);
      const attempt = { version: attemptDraft.version ?? 1, token: attemptDraft.auto_policy_version ?? token };
      const generated = tooShort || titleExcluded ? undefined : await provider.generateStructured({ system: intakeInstructions,
        payload: { title, source: visibleSource }, schema: intakeSchema }, AbortSignal.timeout(60_000));
      const candidate = generated ? parseIntakeResult(generated.value) : undefined;
      // 生成できなかった（除外で本文が残らない／変換に失敗した）ときは、保留にして理由を残す。
      if (!candidate) {
        const heldSaved = await updateIntakeCandidate(env.DB, ownerId, requestId, attempt, { title, publicText: visibleSource,
          aliases: [], topic: "", kept: [], omitted: [],
          questions: [titleExcluded ? messages.intake_excluded_title : messages.intake_excluded_source],
          status: "held", updatedAt: now });
        if (!heldSaved) return await staleAuto(env, ownerId, requestId);
        const held = await getIntakeDraft(env.DB, ownerId, requestId);
        return Response.json({ draft: held ? await draftPayload(env.DB, ownerId, held) : null, autoAdopted: false, held: true,
          reason: titleExcluded ? "excluded_title" : "excluded_source", exclusionRevision: policy.revision,
          usage: generated?.usage }, { headers });
      }
      // 候補の保存と、点検・公開の末尾は finalizeAuto が同じ試行の条件で行う。
      const stored = await getIntakeDraft(env.DB, ownerId, requestId);
      if (!stored) throw new PublicError("intake_missing", 500, messages.intake_missing);
      return await finalizeAuto(env, ownerId, stored, candidate, title, visibleSource, policy, now, attempt, generated?.usage);
    }

    if (action === "save" || action === "hold" || action === "reject") {
      const draftId = text(input.draftId, 1, 80, "intake_draft");
      const draft = await getIntakeDraft(env.DB, ownerId, draftId);
      if (!draft) throw new PublicError("intake_missing", 404, messages.intake_missing);
      // 登録済みの下書きも後から確認・修正できる。再承認すると同じ文書の新しい版になり、古い版は
      // supersededへ移る（公開中の版を直接書き換えない）。公開版の取り消しはcancelで行う。
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
      return Response.json({ draft: await draftPayload(env.DB, ownerId, updated) }, { headers });
    }

    if (action === "cancel") {
      // 自動採用・本人承認のどちらでも、公開版を後から取り消せる。既存の撤回処理へ接続する。
      const draftId = text(input.draftId, 1, 80, "intake_draft");
      const draft = await getIntakeDraft(env.DB, ownerId, draftId);
      if (!draft) throw new PublicError("intake_missing", 404, messages.intake_missing);
      const revisionId = draft.approved_revision_id;
      if (!revisionId) throw new PublicError("intake_draft", 409, "この下書きはまだ登録されていません。");
      const vector = env.VECTORIZE as unknown as WritableVectorIndex;
      // 撤回後は、置換前の旧版を自動で復活させない（既存の撤回処理と同じ）。
      const revoked = await revokeRevision(env.DB, vector, ownerId, revisionId);
      await updateIntakeDraft(env.DB, ownerId, draftId, { title: draft.title, publicText: draft.public_text,
        aliases: intakeJsonList(draft.aliases_json), topic: draft.topic, status: "rejected", updatedAt: now });
      const cancelled = await getIntakeDraft(env.DB, ownerId, draftId);
      return Response.json({ revoked: true, revisionId, vectorCleanupPending: revoked.vectorCleanupPending,
        draft: cancelled ? await draftPayload(env.DB, ownerId, cancelled) : null }, { headers });
    }

    if (action === "approve") {
      const draftId = text(input.draftId, 1, 80, "intake_draft");
      const draft = await getIntakeDraft(env.DB, ownerId, draftId);
      if (!draft) throw new PublicError("intake_missing", 404, messages.intake_missing);
      if (draft.status === "approved") throw new PublicError("intake_draft", 409, "この下書きは登録済みです。");
      const submitted = typeof input.approvalHash === "string" ? input.approvalHash : "";
      if (!submitted || submitted !== await draftHash(draft)) throw new PublicError("intake_stale_hash", 409, messages.intake_stale_hash);
      // 別タブでの保存など、画面が見ている版と保存済みの版が違えば承認しない。
      const submittedVersion = typeof input.version === "number" && Number.isFinite(input.version) ? input.version : NaN;
      if (submittedVersion !== (draft.version ?? 1)) throw new PublicError("intake_stale_version", 409, messages.intake_stale_version);
      // 実際の置換先は、保存済み下書きの対象だけから決める（画面の作成フォームの状態は使わない）。
      const savedTarget = await draftTarget(env.DB, ownerId, draft.source_id, draft.approved_revision_id);
      // 画面が示した対象（期待値）と一致するかを、承認時にもサーバー側で検証する。
      const expected = record(input.expectedTarget ?? {});
      const expectedKind = typeof expected.kind === "string" ? expected.kind : "";
      const expectedRevision = typeof expected.revisionId === "string" ? expected.revisionId : null;
      if (expectedKind !== savedTarget.kind || (savedTarget.kind === "replace" && expectedRevision !== savedTarget.revisionId))
        throw new PublicError("intake_target_changed", 409, messages.intake_target_changed);
      if (savedTarget.kind === "unresolved") throw new PublicError("intake_target_unresolved", 409, messages.intake_target_unresolved);
      // 新規カードの論理ID。置換では、保存済みの内部キーへ同じ文書の次の版として登録する。
      const documentId = intakeDocumentId(draft.id);
      const replacesRevisionId = savedTarget.kind === "replace" ? savedTarget.revisionId! : null;
      const lostFacts = savedTarget.kind === "replace" ? savedTarget.facts ?? 0 : 0;
      // 引き継がれないFactがある場合は、内容を示して了解を取る。無警告で置換しない。
      if (lostFacts > 0 && input.acknowledgeFactLoss !== true) throw new PublicError("intake_facts_loss", 409, messages.intake_facts_loss);
      const targetDocumentKey = savedTarget.kind === "replace" ? savedTarget.documentId : undefined;
      // 空の本文や、除外で本文が残らない下書きは公開しない。
      if (draft.public_text.trim().length < intakeLimits.publicText.min)
        throw new PublicError("intake_text", 400, messages.intake_text);
      // 公開export・検索語・Fact・埋め込みの前に、非表示指定の内容が混ざっていないかを確認する。
      const policy = getContentExclusions(env);
      assertAllowedContent({ title: draft.title, publicText: draft.public_text, aliases: intakeJsonList(draft.aliases_json) }, policy);
      // 公開exportは、公開してよいフィールドだけを組み立てる（原文・省略メモは渡さない）。
      // 公開payloadの全項目の照合はprepareImport側でも行い、承認の直前にもう一度照合する。
      const prepared = await prepareImport(intakeBundle({ ownerId, documentId, title: draft.title,
        publicText: draft.public_text, aliases: intakeJsonList(draft.aliases_json) }),
        { ...(targetDocumentKey ? { documentKey: targetDocumentKey } : {}), policy });
      const embedding = createEmbeddingProvider(env);
      await assertEmbeddingSignature(env.DB, ownerId, embeddingSignature(env), true);
      // 実行時のバインディングは書き込みも持つ。型は読み取り用の面だけを公開している。
      const vector = env.VECTORIZE as unknown as WritableVectorIndex;
      let approved;
      try {
        approved = await approveImport({ db: env.DB, vector, embedding, prepared,
          approvalHash: prepared.hash, signal: AbortSignal.timeout(120_000), policy });
      } catch (error) {
        // 索引の反映待ちは失敗ではなく再試行の案内。現行版は変わっていない。
        if (error instanceof Error && error.message.includes("Vectorizeの反映待ち"))
          throw new PublicError("intake_indexing", 503, messages.intake_indexing);
        throw error;
      }
      if (approved.status === "failed") throw new PublicError("intake_failed", 500, "検索への登録に失敗しました。時間をおいてもう一度お試しください。");
      // 新しい公開版の承認後にだけ、本人が選んだ旧版を撤回する。
      let replaced = false, vectorCleanupPending = false;
      if (replacesRevisionId) {
        const revoked = await revokeRevision(env.DB, vector, ownerId, replacesRevisionId);
        replaced = true; vectorCleanupPending = revoked.vectorCleanupPending;
      }
      await markIntakeApproved(env.DB, ownerId, draftId, { revisionId: prepared.revisionId, hash: prepared.hash, updatedAt: now });
      const updated = await getIntakeDraft(env.DB, ownerId, draftId);
      // 実際に登録した内容（本人が承認した本文・検索語）を返し、画面で照合できるようにする。
      return Response.json({ revisionId: prepared.revisionId, documentId, documentKey: prepared.documentKey,
        replacesRevisionId, replaced, vectorCleanupPending, lostFacts,
        published: { title: draft.title, publicText: draft.public_text, aliases: intakeJsonList(draft.aliases_json), topic: draft.topic },
        draft: updated ? await draftPayload(env.DB, ownerId, updated) : null }, { headers });
    }

    throw new PublicError("INVALID_INPUT", 400, "操作を確認してください。");
  } catch (error) { return failure(error, "管理処理を続けられませんでした。時間をおいてお試しください。", 503); }
}
