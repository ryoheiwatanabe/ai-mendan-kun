// Aモード：人が選んだ根拠を固定し、短い指示で1回だけ生成する。検索・校閲・修復はしない。
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { buildAnswerInput, loadHistories, loadProfile, planCase, promptVersion } from "./lab.mts";
import { callAnswer, type ProviderConfig } from "./provider.mts";
import type { CaseInput } from "./lab.mts";
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
  options: { profile?: FictionalProfile; histories?: Record<string, Turn[]>; overrides?: Partial<CaseInput>; signal?: AbortSignal } = {}
): Promise<RunRecord> {
  const profile = options.profile ?? loadProfile();
  const histories = options.histories ?? loadHistories();
  const history = historyFor(item, histories);
  const plan = planCase(item, options.overrides ?? {}, profile);
  const input = buildAnswerInput(plan.question, history, plan.sentEvidenceIds, profile);
  // 配線の確認用に、意図的に短いタイムアウトで失敗させるケース。
  const effective: ProviderConfig = item.simulate === "timeout" && !options.overrides ? { ...config, timeoutMs: 1 } : config;
  const result = await callAnswer(input.system, input.user, effective, options.signal);
  return {
    runId: randomUUID(),
    at: new Date().toISOString(),
    baseSha: baseSha(),
    phase: "phase1",
    mode: "A",
    caseId: item.id,
    question: plan.question,
    historyId: item.historyId,
    selection: plan.selection,
    sentEvidenceIds: plan.sentEvidenceIds,
    excluded: plan.excluded,
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
