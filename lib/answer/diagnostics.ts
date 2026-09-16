import type { DiagnosticCode } from "../types.ts";

const codes = new Set<DiagnosticCode>([
  "no_evidence", "retrieval_miss", "model_abstained", "unsupported_claim",
  "conflicting_facts", "stale_or_revoked", "generation_error", "verification_error",
  "length_exceeded", "verification_rejected", "retrieval_retry", "repair_attempted",
  "processing_failure", "generation_complete", "verification_complete"
  , "conversation_reply"
  , "candidates_retrieved", "candidates_adopted"
  , "length_trimmed"
  , "time_budget_exhausted"
]);
const numericFields = ["count", "latencyMs", "inputTokens", "outputTokens"] as const;
// 機械確認の理由は固定識別子のみ。本文は決して含めない。
const reasons = new Set(["quote_not_found", "claim_number_unsupported", "claim_coverage", "missing_claims",
  "invalid_limitation", "invalid_support", "support_not_declared", "unknown_evidence", "no_backed_claim",
  "unsupported_fact", "empty_segments", "length_exceeded", "conversation_mixed", "conversation_not_allowed",
  "conversational_claim", "conversation_evidence"]);
// segmentの形が不正なときの理由（guard.ts）。診断では固定識別子だけを残す。
const segmentReasons = new Set(["invalid_text", "text_too_long", "invalid_kind", "invalid_evidence_ids",
  "missing_evidence_ids", "too_many_evidence_ids", "conversation_too_long", "invalid_supports", "missing_supports",
  "invalid_claim", "too_many_claims", "empty_text", "invalid_kind", "interpretation_not_requested",
  "unsupported_name", "unknown_segments"]);
// 校閲が却下した理由。修復指示と同じ固定識別子だけを残す。
const verifierReasons = new Set(["unsupported_claim", "conflicting_facts", "not_answering", "unclear_inference", "length_exceeded"]);

// 質問・回答・根拠本文や識別子を受け渡さず、固定分類と数値だけを記録する。
export function recordAnswerDiagnostic(value: unknown): void {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const input = value as Record<string, unknown>;
    if (typeof input.code !== "string" || !codes.has(input.code as DiagnosticCode)) return;
    const output: Record<string, string | number> = { event: "answer_diagnostic", code: input.code };
    for (const field of numericFields) {
      const number = input[field];
      if (typeof number === "number" && Number.isFinite(number) && number >= 0) output[field] = number;
    }
    if (typeof input.reason === "string"
      && (reasons.has(input.reason) || verifierReasons.has(input.reason) || segmentReasons.has(input.reason))) output.reason = input.reason;
    console.info(JSON.stringify(output));
  } catch {
    // 診断の取得・記録に失敗しても回答処理は止めない。
  }
}
