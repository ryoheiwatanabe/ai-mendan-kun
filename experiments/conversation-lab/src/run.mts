// Aモード：人が選んだ根拠を固定し、短い指示で1回だけ生成する。検索・校閲・修復はしない。
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { buildAnswerInput, filterEvidence, loadHistories, loadProfile, promptVersion } from "./lab.mts";
import { callAnswer, type ProviderConfig } from "./provider.mts";
import type { FictionalProfile, LabCase, RunRecord, Turn } from "./types.mts";

export function baseSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export function historyFor(item: LabCase, histories: Record<string, Turn[]>): Turn[] {
  return item.historyId ? histories[item.historyId] ?? [] : [];
}

export async function runCaseA(
  item: LabCase,
  config: ProviderConfig,
  options: { profile?: FictionalProfile; histories?: Record<string, Turn[]> } = {}
): Promise<RunRecord> {
  const profile = options.profile ?? loadProfile();
  const histories = options.histories ?? loadHistories();
  const history = historyFor(item, histories);
  const { usable, excluded } = filterEvidence(profile, item.selection);
  const input = buildAnswerInput(item, history, usable);
  // 配線の確認用に、意図的に短いタイムアウトで失敗させるケース。
  const effective: ProviderConfig = item.simulate === "timeout" ? { ...config, timeoutMs: 1 } : config;
  const result = await callAnswer(input.system, input.user, effective);
  const at = new Date().toISOString();
  return {
    runId: randomUUID(),
    at,
    baseSha: baseSha(),
    phase: "phase1",
    mode: "A",
    caseId: item.id,
    question: item.question,
    historyId: item.historyId,
    selection: [...item.selection],
    sentEvidenceIds: usable.map(unit => unit.id),
    excluded,
    provider: effective.baseUrl,
    model: effective.model,
    temperature: effective.temperature,
    maxTokens: effective.maxTokens,
    promptVersion,
    status: result.ok ? "ok" : "error",
    errorKind: result.ok ? null : result.errorKind,
    answer: result.ok ? result.payload.answer : "",
    sourceIds: result.ok ? result.payload.sourceIds : [],
    limitations: result.ok ? result.payload.limitations : "",
    timing: result.timing,
    usage: result.usage,
    apiCalls: 1,
    label: null
  };
}
