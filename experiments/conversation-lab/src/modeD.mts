// D条件: 同じ候補・同じ根拠・同じ履歴に対する、現行校閲とJEVの判定比較。
// JEVの結果で回答の採否は変えない（記録のみ）。回答の再生成もしない。
// 根拠は、A/B/Cと同じ共通の受け渡し（チャンクとFactの両方）を使う。
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { evaluateJev, jevKeyFromEnv, jevQuestions, JEV_ENDPOINT, JEV_MODEL, type JevResult } from "./jev.mts";
import { assertPublicNow, toEvidence, type HandoffItem } from "./handoff.mts";
import { verify } from "../../../lib/answer/verifier.ts";
import { parsePayload } from "../../../lib/answer/guard.ts";
import { sha256 } from "../../../lib/knowledge/text.ts";
import type { Snapshot } from "./snapshot.mts";
import type { Evidence, LengthBudget, ModelPayload, Turn } from "../../../lib/types.ts";
import type { RetestRecord } from "./retest.mts";
import type { KnowledgeRepository } from "../../../lib/knowledge/repository.ts";

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
  engineAdopted: string;
  contentHash: string;
}

export function retestRecords(path: string): RetestRecord[] {
  return readFileSync(path, "utf8").split(String.fromCharCode(10)).filter(line => line.trim())
    .map(line => JSON.parse(line) as RetestRecord);
}

// 保存済みの根拠IDを、いまのスナップショットの現行版で読み直す（チャンクとFactの両方）。
export function savedEvidenceItems(snapshot: Snapshot, evidenceIds: string[]): { items: HandoffItem[]; missing: string[] } {
  const items: HandoffItem[] = [];
  const missing: string[] = [];
  for (const id of evidenceIds) {
    if (id.startsWith("fact:")) {
      const parts = id.split(":");
      const revisionId = parts.length >= 3 ? parts[1] : "";
      const factId = parts[parts.length - 1];
      const fact = snapshot.facts.find(entry => entry.id === factId);
      const anchor = snapshot.chunks.find(chunk => chunk.revisionId === revisionId);
      if (!fact || !anchor) { missing.push(id); continue; }
      items.push({ id, kind: "fact", title: factId, text: fact.statement, revisionId,
        documentId: anchor.documentId, contentHash: anchor.contentHash, order: items.length });
      continue;
    }
    const chunk = snapshot.chunks.find(entry => entry.id === id);
    if (!chunk) { missing.push(id); continue; }
    items.push({ id, kind: "chunk", title: chunk.title, text: chunk.content, revisionId: chunk.revisionId,
      documentId: chunk.documentId, contentHash: chunk.contentHash, order: items.length });
  }
  return { items, missing };
}

// 保存済み記録から候補を取り出す。重複は、質問・履歴・根拠・候補本文を含む内容hashで判定する。
export async function candidatesFromRecords(records: RetestRecord[], caseIds: string[]): Promise<{ candidates: CandidateSource[]; dropped: { runId: string; reason: string }[] }> {
  const picked: CandidateSource[] = [];
  const dropped: { runId: string; reason: string }[] = [];
  for (const record of records) {
    if (record.condition !== "C") continue;
    if (caseIds.length && !caseIds.includes(record.caseId)) continue;
    const fidelity = record.handoff?.modelInputIds?.length ? "model_input_recorded" : "saved_evidence_ids_only";
    const adopted = record.handoff?.modelInputIds?.length ? "recorded" : "未保存";
    for (const [kind, payload] of [["initial", record.pipelineLog.candidate1], ["repaired", record.pipelineLog.repairedCandidate]] as const) {
      if (!payload) continue;
      try {
        const parsed = JSON.parse(payload) as ModelPayload;
        const text = parsed.segments.map(segment => segment.text).join(String.fromCharCode(10));
        const contentHash = await sha256(JSON.stringify({ question: record.question, history: record.history,
          evidenceIds: record.evidenceIds, candidate: payload }));
        picked.push({ caseId: record.caseId, sourceRunId: record.runId, condition: record.condition, kind,
          question: record.question, history: record.history, evidenceIds: record.evidenceIds, candidate: text,
          payload, evidenceFidelity: fidelity, engineAdopted: adopted, contentHash });
      } catch {
        dropped.push({ runId: record.runId, reason: "candidate_not_parseable" });
      }
    }
  }
  const unique = new Map<string, CandidateSource>();
  for (const candidate of picked) unique.set(candidate.caseId + "|" + candidate.kind + "|" + candidate.contentHash, candidate);
  const byHash = new Map<string, CandidateSource>();
  for (const candidate of unique.values()) byHash.set(candidate.contentHash, candidate);
  return { candidates: [...byHash.values()], dropped };
}

export interface SideResult {
  executionStatus: "ok" | "error" | "not_run";
  verdict: "accepted" | "rejected" | null;
  reason: string | null;
  errorKind: string | null;
  latencyMs: number;
  responseHeadersMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface CompareRecord {
  compareId: string;
  at: string;
  baseSha: string;
  caseId: string;
  sourceRunId: string;
  candidateKind: string;
  question: string;
  questionHash: string;
  history: Turn[];
  requestedEvidenceIds: string[];
  sentEvidenceIds: string[];
  sentEvidenceTexts: { id: string; kind: string; textHash: string; order: number }[];
  missingEvidenceIds: string[];
  snapshotHash: string;
  contentHash: string;
  candidate: string;
  evidenceFidelity: string;
  engineAdopted: string;
  implementationNote: string[];
  current: SideResult;
  jev: SideResult & { answers: Record<string, { probability: number | null; confidence: number | null; raw: unknown }>; returnedModel: string | null; raw: unknown };
  notes: string[];
}

const budget: LengthBudget = { mode: "normal", max: 220, target: 140 };

async function textHash(text: string): Promise<string> {
  return (await sha256(text)).slice(0, 16);
}

// 現行校閲: 却下（検証の判断）と、利用不能・タイムアウト・通信・形式エラーを分ける。
export async function runCurrentVerification(input: {
  candidate: CandidateSource; evidence: Evidence[]; provider: Parameters<typeof verify>[0]["provider"]; timeoutMs: number;
}): Promise<SideResult> {
  let payload: ModelPayload;
  try {
    payload = parsePayload(JSON.parse(input.candidate.payload) as ModelPayload);
  } catch {
    return { executionStatus: "error", verdict: null, reason: null, errorKind: "candidate_not_parseable",
      latencyMs: 0, responseHeadersMs: null, inputTokens: null, outputTokens: null };
  }
  const started = performance.now();
  try {
    const result = await verify({ provider: input.provider, question: input.candidate.question, history: input.candidate.history,
      evidence: input.evidence, candidate: payload, lengthBudget: budget, highRisk: false }, AbortSignal.timeout(input.timeoutMs));
    const latencyMs = Math.round(performance.now() - started);
    if (result.ok) {
      return { executionStatus: "ok", verdict: "accepted", reason: null, errorKind: null, latencyMs,
        responseHeadersMs: null, inputTokens: result.usage?.input ?? null, outputTokens: result.usage?.output ?? null };
    }
    // 検証の判断による却下（verification_rejected）と、校閲の利用不能・タイムアウト・形式エラーを分ける。
    const rejected = result.reason === "verification_rejected";
    return {
      executionStatus: rejected ? "ok" : "error",
      verdict: rejected ? "rejected" : null,
      reason: result.detail ?? result.reason,
      errorKind: rejected ? null : result.reason,
      latencyMs, responseHeadersMs: null,
      inputTokens: result.usage?.input ?? null, outputTokens: result.usage?.output ?? null
    };
  } catch (error) {
    return { executionStatus: "error", verdict: null, reason: null, errorKind: error instanceof Error ? error.message.slice(0, 40) : "unknown",
      latencyMs: Math.round(performance.now() - started), responseHeadersMs: null, inputTokens: null, outputTokens: null };
  }
}

export async function compareCandidate(input: {
  candidate: CandidateSource; items: HandoffItem[]; snapshotHash: string; baseSha: string;
  provider: Parameters<typeof verify>[0]["provider"]; timeoutMs: number; useJev: boolean;
}): Promise<CompareRecord> {
  const evidence = toEvidence(input.items);
  const current = await runCurrentVerification({ candidate: input.candidate, evidence, provider: input.provider, timeoutMs: input.timeoutMs });
  const jevRaw: JevResult = input.useJev
    ? await evaluateJev({ question: input.candidate.question, history: input.candidate.history, evidence,
        candidate: input.candidate.candidate, apiKey: jevKeyFromEnv(), timeoutMs: input.timeoutMs })
    : { ok: false, errorKind: "not_configured", latencyMs: 0, responseHeadersMs: null, usage: { inputTokens: null, outputTokens: null },
        answers: {}, httpStatus: null, returnedModel: null, raw: null };
  const notes: string[] = [];
  if (input.candidate.evidenceFidelity !== "model_input_recorded") notes.push("保存済み記録にモデル入力の実測が無い。保存済みの根拠IDから本文を引き当てた（旧実行の完全再現ではない）。");
  if (input.candidate.engineAdopted === "未保存") notes.push("エンジン内部の採用根拠（IDと順序）は未保存。");
  if (!jevRaw.ok) notes.push("JEVが正常終了していない（judge_error）。判定の比較には使わず、失敗として記録する。");
  const answers: CompareRecord["jev"]["answers"] = {};
  for (const [key, value] of Object.entries(jevRaw.answers)) {
    answers[key] = { probability: value.probability, confidence: value.confidence, raw: value.raw };
  }
  return {
    compareId: randomUUID(), at: new Date().toISOString(), baseSha: input.baseSha,
    caseId: input.candidate.caseId, sourceRunId: input.candidate.sourceRunId, candidateKind: input.candidate.kind,
    question: input.candidate.question, questionHash: (await sha256(input.candidate.question)).slice(0, 16),
    history: input.candidate.history, requestedEvidenceIds: input.candidate.evidenceIds,
    sentEvidenceIds: input.items.map(item => item.id),
    sentEvidenceTexts: await Promise.all(input.items.map(async item => ({ id: item.id, kind: item.kind, textHash: await textHash(item.text), order: item.order }))),
    missingEvidenceIds: input.candidate.evidenceIds.filter(id => !input.items.some(item => item.id === id)),
    snapshotHash: input.snapshotHash, contentHash: input.candidate.contentHash,
    candidate: input.candidate.candidate, evidenceFidelity: input.candidate.evidenceFidelity, engineAdopted: input.candidate.engineAdopted,
    implementationNote: [
      "JEVへは平文の候補本文を渡す。現行校閲へは構造化した候補（segments/claims/supports）を渡す。",
      "同じ対象内容に対する校閲経路の比較であり、同一プロンプトによるモデル単体の比較ではない。"
    ],
    current,
    jev: {
      executionStatus: jevRaw.ok ? "ok" : "error", verdict: null, reason: jevRaw.errorKind,
      errorKind: jevRaw.errorKind, latencyMs: jevRaw.latencyMs, responseHeadersMs: jevRaw.responseHeadersMs,
      inputTokens: jevRaw.usage.inputTokens, outputTokens: jevRaw.usage.outputTokens,
      answers, returnedModel: jevRaw.returnedModel, raw: jevRaw.raw
    },
    notes
  };
}

export function jevPlan(): { endpoint: string; model: string; questions: string[] } {
  return { endpoint: JEV_ENDPOINT, model: JEV_MODEL, questions: Object.keys(jevQuestions) };
}
