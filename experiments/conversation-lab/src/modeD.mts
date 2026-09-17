// D条件: 同じ候補・同じ根拠・同じ履歴に対する、現行校閲とJEVの判定比較。
// JEVの結果で回答の採否は変えない（記録のみ）。回答の再生成もしない。
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { evaluateJev, jevKeyFromEnv, jevQuestions, JEV_ENDPOINT, JEV_MODEL, type JevResult } from "./jev.mts";
import { verify } from "../../../lib/answer/verifier.ts";
import { parsePayload } from "../../../lib/answer/guard.ts";
import type { Evidence, LengthBudget, ModelPayload, Turn } from "../../../lib/types.ts";
import type { RetestRecord } from "./retest.mts";

export interface CandidateSource {
  caseId: string;
  sourceRunId: string;
  condition: string;
  kind: "initial" | "repaired";
  question: string;
  history: Turn[];
  evidenceIds: string[];
  candidate: string;
  payload: string;
  evidenceFidelity: "saved_evidence_ids_only" | "model_input_recorded";
  engineAdopted: "未保存" | "recorded";
}

// 保存済みの再試験記録から、根拠本文を確定できる候補だけを取り出す。
// モデル入力そのもの（エンジン内部の採用ID・順序）が未保存の記録は、その旨を残して候補だけを使う。
export function candidatesFromRecords(records: RetestRecord[], caseIds: string[]): CandidateSource[] {
  const picked: CandidateSource[] = [];
  for (const record of records) {
    if (record.condition !== "C") continue;
    if (caseIds.length && !caseIds.includes(record.caseId)) continue;
    const fidelity = record.handoff?.modelInputIds?.length ? "model_input_recorded" : "saved_evidence_ids_only";
    const adopted = record.handoff?.modelInputIds?.length ? "recorded" : "未保存";
    for (const [kind, payload] of [["initial", record.pipelineLog.candidate1], ["repaired", record.pipelineLog.repairedCandidate]] as const) {
      if (!payload) continue;
      const segments = JSON.parse(payload) as ModelPayload;
      const text = segments.segments.map(segment => segment.text).join(String.fromCharCode(10));
      picked.push({ caseId: record.caseId, sourceRunId: record.runId, condition: record.condition, kind,
        question: record.question, history: record.history, evidenceIds: record.evidenceIds, candidate: text, payload,
        evidenceFidelity: fidelity, engineAdopted: adopted });
    }
  }
  // 同じ候補（ケース・種類・本文）は1回だけ比較する。
  const unique = new Map<string, CandidateSource>();
  for (const candidate of picked) unique.set(candidate.caseId + "|" + candidate.kind + "|" + candidate.candidate, candidate);
  return [...unique.values()];
}

export function retestRecords(path: string): RetestRecord[] {
  return readFileSync(path, "utf8").split(String.fromCharCode(10)).filter(line => line.trim()).map(line => JSON.parse(line) as RetestRecord);
}

export interface CompareRecord {
  compareId: string;
  at: string;
  caseId: string;
  sourceRunId: string;
  candidateKind: string;
  question: string;
  history: Turn[];
  evidenceIds: string[];
  evidenceTexts: { id: string; text: string }[];
  candidate: string;
  evidenceFidelity: string;
  engineAdopted: string;
  current: { ok: boolean; reason: string | null; latencyMs: number; inputTokens: number | null; outputTokens: number | null; errorKind: string | null };
  jev: JevResult;
  notes: string[];
}

const budget: LengthBudget = { mode: "normal", max: 220, target: 140 };

// 現行校閲を、同じ候補・根拠・履歴で1回だけ実行する（判定の記録用。採否は変えない）。
export async function runCurrentVerification(input: {
  candidate: CandidateSource; evidence: Evidence[]; provider: Parameters<typeof verify>[0]["provider"]; timeoutMs: number;
}): Promise<CompareRecord["current"]> {
  const payload = parsePayload(JSON.parse(input.candidate.payload) as ModelPayload);
  const started = performance.now();
  try {
    const result = await verify({ provider: input.provider, question: input.candidate.question, history: input.candidate.history,
      evidence: input.evidence, candidate: payload, lengthBudget: budget, highRisk: false },
      AbortSignal.timeout(input.timeoutMs));
    return { ok: result.ok, reason: result.ok ? null : result.detail ?? result.reason,
      latencyMs: Math.round(performance.now() - started),
      inputTokens: result.usage?.input ?? null, outputTokens: result.usage?.output ?? null, errorKind: null };
  } catch (error) {
    return { ok: false, reason: null, latencyMs: Math.round(performance.now() - started), inputTokens: null, outputTokens: null,
      errorKind: error instanceof Error ? error.message.slice(0, 40) : "unknown" };
  }
}

export async function compareCandidate(input: {
  candidate: CandidateSource; evidence: Evidence[]; provider: Parameters<typeof verify>[0]["provider"];
  timeoutMs: number; useJev: boolean;
}): Promise<CompareRecord> {
  const current = await runCurrentVerification({ candidate: input.candidate, evidence: input.evidence, provider: input.provider, timeoutMs: input.timeoutMs });
  const jev: JevResult = input.useJev
    ? await evaluateJev({ question: input.candidate.question, history: input.candidate.history, evidence: input.evidence,
        candidate: input.candidate.candidate, apiKey: jevKeyFromEnv(), timeoutMs: input.timeoutMs })
    : { ok: false, errorKind: "not_configured", latencyMs: 0, usage: { inputTokens: null, outputTokens: null }, answers: {}, httpStatus: null };
  const notes: string[] = [];
  if (input.candidate.evidenceFidelity !== "model_input_recorded") notes.push("モデル入力の実測は未保存。保存済みの根拠IDから本文を引き当てた。");
  if (input.candidate.engineAdopted === "未保存") notes.push("エンジン内部の採用根拠（IDと順序）は未保存。");
  if (!jev.ok) notes.push("JEVが正常終了していない（judge_error）。判定の比較には使わず、失敗として記録する。");
  return {
    compareId: randomUUID(), at: new Date().toISOString(), caseId: input.candidate.caseId, sourceRunId: input.candidate.sourceRunId,
    candidateKind: input.candidate.kind, question: input.candidate.question, history: input.candidate.history,
    evidenceIds: input.candidate.evidenceIds,
    evidenceTexts: input.evidence.map(item => ({ id: item.id, text: item.content })),
    candidate: input.candidate.candidate, evidenceFidelity: input.candidate.evidenceFidelity, engineAdopted: input.candidate.engineAdopted,
    current, jev, notes
  };
}

export function jevPlan(): { endpoint: string; model: string; questions: string[] } {
  return { endpoint: JEV_ENDPOINT, model: JEV_MODEL, questions: Object.keys(jevQuestions) };
}
