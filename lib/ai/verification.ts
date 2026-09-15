import type { ModelPayload, Segment } from "../types.ts";
import { verificationReasons, type VerificationReason } from "./prompt.ts";

// 検証応答の共有パーサ。providerごとのfinal processingから呼び、DRYに保つ。
// 判定は{accepted, reason}のみ。candidate本文は受け取らないため、書き換え合格が構造的に起こらない。
export interface VerificationOutcome {
  accepted: boolean;
  reason: VerificationReason;
  // 合格で候補が保持された場合のみ候補を返す。nullは不合格(呼び出し側で空+unknownへ落とす)。
  payload: ModelPayload | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isReason(value: unknown): value is VerificationReason {
  return typeof value === "string" && (verificationReasons as readonly string[]).includes(value);
}

// rawはunknown(JSON.parse結果)。厳密に{accepted, reason}の2キーのみを許可する。
export function parseVerification(raw: unknown, candidate?: ModelPayload): VerificationOutcome {
  if (!record(raw)) throw new Error("invalid_verification_payload");
  const keys = Object.keys(raw);
  if (keys.length !== 2 || !keys.includes("accepted") || !keys.includes("reason")) throw new Error("invalid_verification_payload");
  if (typeof raw.accepted !== "boolean" || !isReason(raw.reason)) throw new Error("invalid_verification_payload");
  if (raw.accepted) {
    // 合格はreason=acceptedかつcandidateが存在する場合のみ成立。候補は決して書き換えない。
    if (raw.reason !== "accepted" || !candidate) throw new Error("invalid_verification_payload");
    const payload = structuredClone(candidate);
    return { accepted: true, reason: "accepted", payload };
  }
  // 不合格は候補を破棄し、空segments/unknown/lowに固定する。
  const empty: ModelPayload = { segments: [] as Segment[], answerability: "unknown", confidence: "low" };
  return { accepted: false, reason: raw.reason, payload: empty };
}
