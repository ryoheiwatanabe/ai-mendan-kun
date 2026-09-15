import type { DiagnosticCode } from "../types.ts";

const codes = new Set<DiagnosticCode>([
  "no_evidence", "retrieval_miss", "model_abstained", "unsupported_claim",
  "conflicting_facts", "stale_or_revoked", "generation_error", "verification_error",
  "length_exceeded", "verification_rejected", "retrieval_retry", "repair_attempted",
  "processing_failure", "generation_complete", "verification_complete"
]);
const numericFields = ["count", "latencyMs", "inputTokens", "outputTokens"] as const;

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
    console.info(JSON.stringify(output));
  } catch {
    // 診断の取得・記録に失敗しても回答処理は止めない。
  }
}
