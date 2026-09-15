import type { AnswerProvider, DiagnosticsCallback, Evidence, LengthBudget, ModelPayload, Turn } from "../types.ts";
import { sameCandidate, parsePayload } from "./guard.ts";

const verifyTimeoutMs = 20000;

export type VerifyResult = {
  ok: true;
  usage: { input: number; output: number } | null;
} | {
  ok: false;
  reason: "verification_rejected" | "verifier_unavailable" | "verification_error";
  usage: { input: number; output: number } | null;
};

// 検証は同一provider.streamをpurpose=verifyで1回だけ呼ぶ。
// 検証が合格した候補は、生成候補と構造・テキストともに完全一致を要求する。
// 不一致(書き換えられた候補)は未検証テキストとして棄却する。
// 各 yield 前に abort を確認し、usage を呼び出し側へ返す。
export async function verify(input: {
  provider: AnswerProvider; question: string; history: Turn[];
  evidence: Evidence[]; candidate: ModelPayload; lengthBudget: LengthBudget; highRisk: boolean;
  diagnostics?: DiagnosticsCallback;
}, signal: AbortSignal): Promise<VerifyResult> {
  const expected = parsePayload(structuredClone(input.candidate));
  let verified: ModelPayload | null = null;
  let usage: { input: number; output: number } | null = null;
  let seenComplete = false;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), verifyTimeoutMs);
  const combined = AbortSignal.any([signal, timeout.signal]);
  combined.throwIfAborted();
  try {
    for await (const output of input.provider.stream({
      question: input.question, history: input.history, evidence: input.evidence, highRisk: input.highRisk,
      purpose: "verify", candidate: structuredClone(expected), lengthBudget: input.lengthBudget
    }, combined)) {
      combined.throwIfAborted();
      if (output.type === "complete") {
        if (seenComplete) return { ok: false, reason: "verification_rejected", usage };
        seenComplete = true;
        verified = output.payload;
        if (output.usage) usage = output.usage;
      }
    }
  } catch (error) {
    if (signal.aborted) throw error;
    return { ok: false, reason: "verifier_unavailable", usage };
  } finally {
    clearTimeout(timer);
  }
  signal.throwIfAborted();
  if (!verified) return { ok: false, reason: "verifier_unavailable", usage };
  if (!verified.segments.length || verified.answerability === "unknown") return { ok: false, reason: "verification_rejected", usage };
  if (!sameCandidate(verified, expected)) return { ok: false, reason: "verification_rejected", usage };
  return { ok: true, usage };
}
