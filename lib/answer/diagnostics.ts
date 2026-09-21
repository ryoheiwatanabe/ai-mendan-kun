import type { DiagnosticCode } from "../types.ts";
import { jevQuestionIds } from "../ai/jev.ts";
import { jevScopeNoulIds } from "../ai/jev-scope.ts";

const codes = new Set<DiagnosticCode>([
  "content_excluded", "voice_input_blocked", "voice_input_edited", "voice_input_normalize", "voice_input_skipped",
  "jev_request_complete", "jev_request_failed",
  "no_evidence", "retrieval_miss", "model_abstained", "unsupported_claim",
  "conflicting_facts", "stale_or_revoked", "generation_error", "verification_error",
  "length_exceeded", "verification_rejected", "retrieval_retry", "repair_attempted",
  "processing_failure", "generation_complete", "verification_complete"
  , "conversation_reply"
  , "candidates_retrieved", "candidates_adopted"
  , "length_trimmed"
  , "time_budget_exhausted"
  , "answer_context", "route", "overview_cache", "retrieval_complete"
  , "generation_attempt", "jev_attempt", "jev_complete", "jev_rejected", "jev_error", "repair_complete", "answer_ready", "stt_complete", "tts_complete"
  , "answer_timeout", "answer_aborted", "stream_failure"
  , "jev_settings_fallback"
  , "scope_attempt", "scope_complete", "scope_error", "scope_skipped"
  , "scope_primary_rejected", "scope_low_confidence"
  , "screening_attempt", "screening_complete", "screening_error"
  , "evidence_id_normalized"
  , "screening_dropped", "stages_used"
  , "repair_skipped"
  , "beam_attempt", "beam_complete", "beam_skipped", "beam_expanded", "beam_merged"
  , "triage_route", "answer_accepted", "candidate_rejected", "pipeline_complete", "pipeline_failed"
]);
const numericFields = ["count", "latencyMs", "inputTokens", "outputTokens"] as const;
// 固定条件の識別子。英数字と記号だけを許可し、本文や自由文が混ざる余地を残さない。
const identifierFields: [string, RegExp][] = [
  ["purpose", /^(scope|screening|routes|verification|input_normalization|intake_review)$/],
  ["provider", /^[a-z0-9_-]{1,32}$/],
  ["model", /^[A-Za-z0-9._:-]{1,64}$/],
  ["promptVersion", /^[0-9a-f]{8}$/],
  ["traceId", /^[0-9a-f-]{8,64}$/],
  // 採点設定の版と取得元。保存値が壊れて既定へ戻した場合も理由が分かるようにする。
  ["settingsVersion", /^[0-9]{1,9}$/],
  ["settingsSource", /^(stored|default|invalid)$/],
  // 選別のChoice結果。選択肢の識別子だけを許可する。
  ["scopeChoice", /^(answerable|partial|insufficient|ambiguous)$/]
];
// 0〜1の値だけを受け付ける数値項目（確信度・支持の強さ）。正答率ではない。
const ratioFields = ["confidence", "supportStrength"] as const;
// 機械確認の理由は固定識別子のみ。本文は決して含めない。
const reasons = new Set(["judge_unavailable", "jev_failed", "question", "filler_only", "backchannel", "unclear", "quote_not_found", "claim_number_unsupported", "claim_coverage", "missing_claims",
  "sensitive_raw", "critical_tokens", "answer_masked",
  "invalid_limitation", "invalid_support", "support_not_declared", "unknown_evidence", "no_backed_claim",
  "unsupported_fact", "empty_segments", "length_exceeded", "conversation_mixed", "conversation_not_allowed",
  "conversational_claim", "conversation_evidence", "stored_settings_invalid",
  // 生成前の選別を見送った理由。コードとセットで固定識別子だけを残す。
  "disabled", "time_insufficient", "judge_unsupported", "scope_unavailable", "stage_limit",
  // 低確信時の行き先。
  "proceed", "second-stage", "partial", "hold",
  // 絞り込みの選び方と、範囲外へ落とした理由、2段目の印。
  "retrieval_rank", "beyond_screen_limit", "tie_break",
  "direct_support", "direct", "partial", "clarify", "insufficient", "unresolved",
  // 生成前の振り分けで、質問の前提（対象・時期）が決まらないことを示す。
  "context_missing",
  // 資料からは答えられないと判断して、生成を重ねずに定型の案内へ落ちたことを示す。
  "not_answerable",
  // 段数の上限を使い切った後も、定型の案内だけは最終点検へ通したことを示す。
  "stage_overrun",
  "first_pass", "repaired", "clarification", "clarification_only", "insufficient_evidence",
  "format", "meaning_or_check", "evidence_or_check",
  "rejected", "held", "timeout", "unavailable", "processing", "aborted",
  "round_1", "round_2", "round_3", "candidates_insufficient", "routes_insufficient",
  "first_attempt", "final_attempt", "retry"]);
// segmentの形が不正なときの理由（guard.ts）。診断では固定識別子だけを残す。
const segmentReasons = new Set(["invalid_text", "text_too_long", "invalid_kind", "invalid_evidence_ids",
  "missing_evidence_ids", "too_many_evidence_ids", "conversation_too_long", "invalid_supports", "missing_supports",
  "invalid_claim", "too_many_claims", "empty_text", "invalid_kind", "interpretation_not_requested",
  "unsupported_name", "unknown_segments", "invalid_compact_payload",
  "target_match", "aspect_match", "claims_supported", "no_invented_causality", "no_scope_expansion", "no_unnecessary_abstention"]);
// 校閲が却下した理由。修復指示と同じ固定識別子だけを残す。
const verifierReasons = new Set(["unsupported_claim", "conflicting_facts", "not_answering", "unclear_inference", "length_exceeded"]);
// どの経路で答えたか。順序は上の分岐の順に対応する。
const routeReasons = new Set(["injection", "decision", "private_disclosure", "conversation", "subject_follow_up",
  "overview", "retrieval", "unavailable"]);
// 経歴概要のキャッシュを使えたか、使えなかった理由。
const overviewReasons = new Set(["content_excluded","cache_hit", "not_configured", "invalid_format", "text_too_long", "sources_missing",
  "fingerprint_mismatch", "snapshot_stale"]);
// 応答ストリームが例外で終わった原因。中止とそれ以外を分ける。
const streamReasons = new Set(["iterator_threw", "iterator_aborted"]);

// 固定条件の識別子だけを取り出す。決めた形に一致しない値は捨てる。
export function contextFields(value: unknown): Record<string, string> {
  const output: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return output;
  const input = value as Record<string, unknown>;
  for (const [field, pattern] of identifierFields) {
    const item = input[field];
    if (typeof item === "string" && pattern.test(item)) output[field] = item;
  }
  return output;
}

// 質問・回答・根拠本文や識別子を受け渡さず、固定分類と数値だけを記録する。
export function recordAnswerDiagnostic(value: unknown): void {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const input = value as Record<string, unknown>;
    if (typeof input.code !== "string" || !codes.has(input.code as DiagnosticCode)) return;
    const output: Record<string, string | number | Record<string, number>> = { event: "answer_diagnostic", code: input.code };
    for (const field of numericFields) {
      const number = input[field];
      if (typeof number === "number" && Number.isFinite(number) && number >= 0) output[field] = number;
    }
    for (const field of ratioFields) {
      const number = input[field];
      if (typeof number === "number" && Number.isFinite(number) && number >= 0 && number <= 1) output[field] = number;
    }
    Object.assign(output, contextFields(input));
    // 軸別スコアは、既知の軸と0〜1の数値だけを残す。本文や自由文は入らない。
    const scores = numberMap(input.scores, jevQuestionIds);
    if (scores) output.scores = scores;
    const scopeScores = numberMap(input.scopeScores, jevScopeNoulIds);
    if (scopeScores) output.scopeScores = scopeScores;
    if (typeof input.reason === "string"
      && (reasons.has(input.reason) || verifierReasons.has(input.reason) || segmentReasons.has(input.reason)
        || routeReasons.has(input.reason) || overviewReasons.has(input.reason)
        || streamReasons.has(input.reason))) output.reason = input.reason;
    console.info(JSON.stringify(output));
  } catch {
    // 診断の取得・記録に失敗しても回答処理は止めない。
  }
}

// 既知の軸と0〜1の数値だけを取り出す。形が違う値や未知の軸は捨てる。
function numberMap(value: unknown, axes: readonly string[]): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kept: Record<string, number> = {};
  for (const axis of axes) {
    const score = (value as Record<string, unknown>)[axis];
    if (typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 1) kept[axis] = score;
  }
  return Object.keys(kept).length ? kept : null;
}
