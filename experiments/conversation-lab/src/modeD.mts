// D条件: 同じ候補・同じ根拠・同じ履歴に対する、現行校閲とJEVの判定比較。
// JEVの結果で回答の採否は変えない（記録のみ）。回答の再生成もしない。
// 根拠は、A/B/Cと同じ共通の受け渡し（チャンクとFactの両方）を使い、送信前に公開・所属・本文を照合する。
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { evaluateJev, jevKeyFromEnv, jevQuestions, jevRules, JEV_ENDPOINT, JEV_MODEL, type JevResult } from "./jev.mts";
import { assertPublicNow, toEvidence, type HandoffItem } from "./handoff.mts";
import { verify } from "../../../lib/answer/verifier.ts";
import { parsePayload } from "../../../lib/answer/guard.ts";
import { sha256 } from "../../../lib/knowledge/text.ts";
import type { Snapshot } from "./snapshot.mts";
import type { Evidence, Fact, LengthBudget, ModelPayload, Turn } from "../../../lib/types.ts";
import type { RetestRecord } from "./retest.mts";
import type { KnowledgeRepository } from "../../../lib/knowledge/repository.ts";

export interface CandidateSource {
  caseId: string;
  sourceRunId: string;
  sourceRefs: { runId: string; caseId: string; candidateKind: string; baseSha: string; snapshotHash: string }[];
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
  modelInputIds: string[];
  // 段階A: 元取得ID（evidenceIds）と、実際に送る保存入力ID（savedInputIds）を分けて持つ。
  savedInputIds: string[];
  inputProblem: string | null;
}

export function retestRecords(path: string): RetestRecord[] {
  return readFileSync(path, "utf8").split(String.fromCharCode(10)).filter(line => line.trim())
    .map(line => JSON.parse(line) as RetestRecord);
}

// 保存済みの根拠IDを、いまの公開承認済み集合から引き当てる。
// - チャンク: 現行の公開チャンクと一致し、IDの版部分が現在のrevisionと一致すること。
// - Fact: アプリの facts()（公開・承認・現行版・ownerを条件に取得）にあること。
//   IDの版・文書が、そのFact自身のrevision・documentと一致すること。本文はFactの承認文を使う。
export async function savedEvidenceItems(snapshot: Snapshot, repository: KnowledgeRepository, evidenceIds: string[]): Promise<{
  items: HandoffItem[]; missing: string[]; problems: string[];
}> {
  const items: HandoffItem[] = [];
  const missing: string[] = [];
  const problems: string[] = [];
  const facts: Fact[] = evidenceIds.some(id => id.startsWith("fact:")) ? await repository.facts() : [];
  for (const id of evidenceIds) {
    if (id.startsWith("fact:")) {
      const parts = id.split(":");
      const revisionId = parts.length >= 3 ? parts[1] : "";
      const factName = parts[parts.length - 1];
      // Fact.id は rev_xxx:fact-name。Evidence IDは fact:rev_xxx:fact-name。
      // 末尾だけで比較せず、公開承認済みFact集合に対して完全IDで照合する。
      const fact = facts.find(entry => "fact:" + entry.id === id);
      if (!fact) { missing.push(id); continue; }
      if (!/^rev_[^:]+:/.test(fact.id)) { problems.push(id + ":fact_id_format"); continue; }
      // 所属の照合: IDが指す版・文書と、Fact自身の版・文書が一致すること。
      if (fact.revision_id !== revisionId) { problems.push(id + ":fact_revision_mismatch"); continue; }
      const anchor = snapshot.chunks.find(chunk => chunk.revisionId === fact.revision_id && chunk.documentId === fact.document_id);
      if (!anchor) { problems.push(id + ":fact_document_mismatch"); continue; }
      items.push({ id, kind: "fact", title: factName, text: fact.statement, revisionId: fact.revision_id,
        documentId: fact.document_id, contentHash: anchor.contentHash, order: items.length });
      continue;
    }
    const chunk = snapshot.chunks.find(entry => entry.id === id);
    if (!chunk) { missing.push(id); continue; }
    // 版の照合: IDの版部分が、現在のrevisionと一致すること。
    if (chunk.revisionId !== id.split(":")[0]) { problems.push(id + ":chunk_revision_mismatch"); continue; }
    items.push({ id, kind: "chunk", title: chunk.title, text: chunk.content, revisionId: chunk.revisionId,
      documentId: chunk.documentId, contentHash: chunk.contentHash, order: items.length });
  }
  return { items, missing, problems };
}

// 保存済み記録から候補を取り出す。重複は、実際に送る入力（質問・履歴・根拠・構造化候補）のhashで判定し、
// 同じ内容の由来（runId等）はすべて残す。
export async function candidatesFromRecords(records: RetestRecord[], caseIds: string[]): Promise<{ candidates: CandidateSource[]; dropped: { runId: string; reason: string }[] }> {
  const dropped: { runId: string; reason: string }[] = [];
  const picked: CandidateSource[] = [];
  for (const record of records) {
    if (record.condition !== "C") continue;
    if (caseIds.length && !caseIds.includes(record.caseId)) continue;
    const fidelity = record.handoff?.modelInputIds?.length ? "model_input_recorded" : "saved_evidence_ids_only";
    const adopted = record.handoff?.modelInputIds?.length ? "recorded" : "未保存";
    for (const [kind, payload] of [["initial", record.pipelineLog.candidate1], ["repaired", record.pipelineLog.repairedCandidate]] as const) {
      if (!payload) continue;
      let text = "";
      try {
        text = (JSON.parse(payload) as ModelPayload).segments.map(segment => segment.text).join(String.fromCharCode(10));
      } catch {
        dropped.push({ runId: record.runId, reason: "candidate_not_parseable" });
        continue;
      }
      // 段階A: ここでは統合しない。元取得IDと保存入力IDを別々に保ち、不整合は停止理由にする。
      const modelInputIds = record.handoff?.modelInputIds ?? [];
      const savedInputIds = modelInputIds.length ? modelInputIds : record.evidenceIds;
      const candidateCheck = parseCandidatePayload(payload);
      const inputProblem = modelInputIds.length && !modelInputIds.every(id => record.evidenceIds.includes(id))
        ? "saved_input_inconsistent"
        : candidateCheck.ok ? null : (candidateCheck.reason ?? "candidate_invalid");
      const contentHash = await sha256(JSON.stringify({ question: record.question, history: record.history,
        evidenceIds: savedInputIds, candidate: payload }));
      const sourceRef = { runId: record.runId, caseId: record.caseId, candidateKind: kind,
        baseSha: String(record.manifest?.baseSha ?? ""), snapshotHash: String(record.manifest?.snapshotHash ?? "") };
      picked.push({ caseId: record.caseId, sourceRunId: record.runId, sourceRefs: [sourceRef],
        condition: record.condition, kind, question: record.question, history: record.history,
        evidenceIds: record.evidenceIds, savedInputIds, candidate: text, payload,
        evidenceFidelity: modelInputIds.length ? "model_input_recorded" : "saved_evidence_ids_only",
        engineAdopted: adopted, contentHash, modelInputIds, inputProblem });
    }
  }
  return { candidates: picked, dropped };
}

export interface SideResult {
  executionStatus: "ok" | "error" | "not_run";
  verdict: "accepted" | "rejected" | null;
  reason: string | null;
  errorKind: string | null;
  apiCalls: number;
  latencyMs: number;
  responseHeadersMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface CompareRecord {
  compareId: string;
  at: string;
  baseSha: string;
  sourceRunId: string;
  sourceRefs: CandidateSource["sourceRefs"];
  caseId: string;
  candidateKind: string;
  question: string;
  history: Turn[];
  structuredCandidate: string;
  requestedEvidenceIds: string[];
  sentEvidenceIds: string[];
  sentEvidence: { id: string; kind: string; title: string; text: string; order: number }[];
  missingEvidenceIds: string[];
  snapshotHash: string;
  contentHash: string;
  judgeDefinitionHash: string;
  requested: { currentModel: string; currentEndpoint: string; jevModel: string; jevEndpoint: string };
  returnedModel: string | null;
  evidenceFidelity: string;
  engineAdopted: string;
  implementationNote: string[];
  current: SideResult;
  jev: SideResult & { answers: Record<string, { probability: number | null; confidence: number | null; raw: unknown }> };
  notes: string[];
}

const budget: LengthBudget = { mode: "normal", max: 220, target: 140 };

export async function judgeDefinitionHash(): Promise<string> {
  return (await sha256(JSON.stringify({ questions: jevQuestions, rules: jevRules }))).slice(0, 16);
}

export function notRunRecord(input: { candidate: CandidateSource; snapshotHash: string; baseSha: string;
  currentModel: string; currentEndpoint: string; reason: string; definitionHash: string }): CompareRecord {
  const side = (reason: string): SideResult => ({ executionStatus: "not_run", verdict: null, reason, errorKind: null,
    apiCalls: 0, latencyMs: 0, responseHeadersMs: null, inputTokens: null, outputTokens: null });
  return {
    compareId: randomUUID(), at: new Date().toISOString(), baseSha: input.baseSha,
    sourceRunId: input.candidate.sourceRunId, sourceRefs: input.candidate.sourceRefs, caseId: input.candidate.caseId,
    candidateKind: input.candidate.kind, question: input.candidate.question, history: input.candidate.history,
    structuredCandidate: input.candidate.payload, requestedEvidenceIds: input.candidate.evidenceIds,
    sentEvidenceIds: [], sentEvidence: [], missingEvidenceIds: input.candidate.evidenceIds,
    snapshotHash: input.snapshotHash, contentHash: input.candidate.contentHash,
    judgeDefinitionHash: input.definitionHash,
    requested: { currentModel: input.currentModel, currentEndpoint: input.currentEndpoint, jevModel: JEV_MODEL, jevEndpoint: JEV_ENDPOINT },
    returnedModel: null, evidenceFidelity: input.candidate.evidenceFidelity, engineAdopted: input.candidate.engineAdopted,
    implementationNote: ["送信前の確認で停止した。両校閲へは送っていない。"],
    current: side(input.reason), jev: { ...side(input.reason), answers: {} }, notes: [input.reason]
  };
}

export async function runCurrentVerification(input: {
  candidate: CandidateSource; evidence: Evidence[]; provider: Parameters<typeof verify>[0]["provider"]; timeoutMs: number;
}): Promise<SideResult> {
  let payload: ModelPayload;
  try {
    payload = parsePayload(JSON.parse(input.candidate.payload) as ModelPayload);
  } catch {
    return { executionStatus: "error", verdict: null, reason: null, errorKind: "candidate_not_parseable",
      apiCalls: 0, latencyMs: 0, responseHeadersMs: null, inputTokens: null, outputTokens: null };
  }
  const started = performance.now();
  try {
    const result = await verify({ provider: input.provider, question: input.candidate.question, history: input.candidate.history,
      evidence: input.evidence, candidate: payload, lengthBudget: budget, highRisk: false }, AbortSignal.timeout(input.timeoutMs));
    const latencyMs = Math.round(performance.now() - started);
    if (result.ok) {
      return { executionStatus: "ok", verdict: "accepted", reason: null, errorKind: null, apiCalls: 1, latencyMs,
        responseHeadersMs: null, inputTokens: result.usage?.input ?? null, outputTokens: result.usage?.output ?? null };
    }
    const rejected = result.reason === "verification_rejected";
    return { executionStatus: rejected ? "ok" : "error", verdict: rejected ? "rejected" : null,
      reason: result.detail ?? result.reason, errorKind: rejected ? null : result.reason, apiCalls: 1, latencyMs,
      responseHeadersMs: null, inputTokens: result.usage?.input ?? null, outputTokens: result.usage?.output ?? null };
  } catch (error) {
    return { executionStatus: "error", verdict: null, reason: null,
      errorKind: error instanceof Error ? error.message.slice(0, 40) : "unknown", apiCalls: 1,
      latencyMs: Math.round(performance.now() - started), responseHeadersMs: null, inputTokens: null, outputTokens: null };
  }
}

export async function compareCandidate(input: {
  candidate: CandidateSource; items: HandoffItem[]; snapshotHash: string; baseSha: string;
  currentModel: string; currentEndpoint: string;
  provider: Parameters<typeof verify>[0]["provider"]; timeoutMs: number; useJev: boolean;
}): Promise<CompareRecord> {
  const evidence = toEvidence(input.items);
  const definitionHash = await judgeDefinitionHash();
  const current = await runCurrentVerification({ candidate: input.candidate, evidence, provider: input.provider, timeoutMs: input.timeoutMs });
  const jevRaw: JevResult = input.useJev
    ? await evaluateJev({ question: input.candidate.question, history: input.candidate.history, evidence,
        candidate: input.candidate.candidate, apiKey: jevKeyFromEnv(), timeoutMs: input.timeoutMs })
    : { ok: false, errorKind: null, latencyMs: 0, responseHeadersMs: null, usage: { inputTokens: null, outputTokens: null },
        answers: {}, httpStatus: null, returnedModel: null, raw: null };
  const notes: string[] = [];
  if (input.candidate.evidenceFidelity !== "model_input_recorded") notes.push("保存済み記録にモデル入力の実測が無い。共通の受け渡しで固定した入力を新たに使い、旧実行の再現とは扱わない。");
  if (input.candidate.engineAdopted === "未保存") notes.push("エンジン内部の採用根拠（IDと順序）は未保存。");
  if (input.candidate.sourceRefs.length > 1) notes.push("同じ内容の由来が複数ある（sourceRefs参照）。");
  if (!jevRaw.ok && input.useJev) notes.push("JEVが正常終了していない（judge_error）。判定の比較には使わず、失敗として記録する。");
  const answers: CompareRecord["jev"]["answers"] = {};
  for (const [key, value] of Object.entries(jevRaw.answers)) {
    answers[key] = { probability: value.probability, confidence: value.confidence, raw: value.raw };
  }
  return {
    compareId: randomUUID(), at: new Date().toISOString(), baseSha: input.baseSha,
    sourceRunId: input.candidate.sourceRunId, sourceRefs: input.candidate.sourceRefs, caseId: input.candidate.caseId,
    candidateKind: input.candidate.kind, question: input.candidate.question, history: input.candidate.history,
    structuredCandidate: input.candidate.payload, requestedEvidenceIds: input.candidate.evidenceIds,
    sentEvidenceIds: input.items.map(item => item.id),
    // 本文も丸ごと残す（別環境へ渡しても検証できるようにする）。
    sentEvidence: input.items.map(item => ({ id: item.id, kind: item.kind, title: item.title, text: item.text, order: item.order })),
    missingEvidenceIds: input.candidate.evidenceIds.filter(id => !input.items.some(item => item.id === id)),
    snapshotHash: input.snapshotHash, contentHash: input.candidate.contentHash, judgeDefinitionHash: definitionHash,
    requested: { currentModel: input.currentModel, currentEndpoint: input.currentEndpoint, jevModel: JEV_MODEL, jevEndpoint: JEV_ENDPOINT },
    returnedModel: jevRaw.returnedModel, evidenceFidelity: input.candidate.evidenceFidelity, engineAdopted: input.candidate.engineAdopted,
    implementationNote: [
      "JEVへは平文の候補本文を渡す。現行校閲へは構造化した候補（segments/claims/supports）を渡す。",
      "同じ対象内容に対する校閲経路の比較であり、同一プロンプトによるモデル単体の比較ではない。"
    ],
    current,
    jev: {
      executionStatus: input.useJev ? (jevRaw.ok ? "ok" : "error") : "not_run",
      verdict: null, reason: input.useJev ? jevRaw.errorKind : "--no-jev", errorKind: input.useJev ? jevRaw.errorKind : null,
      apiCalls: input.useJev ? 1 : 0, latencyMs: jevRaw.latencyMs, responseHeadersMs: jevRaw.responseHeadersMs,
      inputTokens: jevRaw.usage.inputTokens, outputTokens: jevRaw.usage.outputTokens, answers
    },
    notes
  };
}

export function jevPlan(): { endpoint: string; model: string; questions: string[] } {
  return { endpoint: JEV_ENDPOINT, model: JEV_MODEL, questions: Object.keys(jevQuestions) };
}

// 構造化候補を、アプリと同じ parsePayload で検証する（両校閲を呼ぶ前の共通確認）。
export function parseCandidatePayload(payload: string): { ok: boolean; reason: string | null } {
  try {
    const parsed = parsePayload(JSON.parse(payload) as ModelPayload);
    if (!parsed.segments.length && parsed.answerability !== "unknown") return { ok: false, reason: "candidate_no_segments" };
    return { ok: true, reason: null };
  } catch {
    return { ok: false, reason: "candidate_invalid_payload" };
  }
}

// 送信前の共通確認。1つでも問題があれば、両校閲を呼ばずに not_run とする。
export function preflightProblems(input: { missing: string[]; problems: string[]; dropped: string[];
  candidate: { ok: boolean; reason: string | null }; snapshotMismatch: boolean; keyProblem: string | null;
  endpointMismatch: boolean }): string[] {
  return [
    ...input.missing.map(id => "evidence_missing:" + id),
    ...input.problems,
    ...input.dropped.map(id => "evidence_not_public:" + id),
    ...(input.candidate.ok ? [] : [input.candidate.reason ?? "candidate_invalid"]),
    ...(input.snapshotMismatch ? ["snapshot_mismatch"] : []),
    ...(input.endpointMismatch ? ["endpoint_mismatch"] : []),
    ...(input.keyProblem ? [input.keyProblem] : [])
  ];
}

export interface FinalCandidate extends CandidateSource {
  inputHash: string;
  items: HandoffItem[];
  problems: string[];
}

// 段階B: 元記録ごとに整合性と根拠を確定してから統合する。
export async function finalizeCandidates(input: {
  candidates: CandidateSource[]; snapshot: Snapshot; repository: KnowledgeRepository;
}): Promise<{ candidates: FinalCandidate[]; stopped: { candidate: CandidateSource; reason: string }[] }> {
  const stopped: { candidate: CandidateSource; reason: string }[] = [];
  const byInput = new Map<string, FinalCandidate>();
  for (const candidate of input.candidates) {
    if (candidate.inputProblem) { stopped.push({ candidate, reason: candidate.inputProblem }); continue; }
    // 由来ごとにsnapshotの整合を確認する（統合の前）。
    const consistent = candidate.sourceRefs.filter(ref => !ref.snapshotHash || ref.snapshotHash === input.snapshot.hash);
    if (!consistent.length) { stopped.push({ candidate, reason: "snapshot_mismatch" }); continue; }
    const resolved = await savedEvidenceItems(input.snapshot, input.repository, candidate.savedInputIds);
    const problems = [...resolved.problems, ...resolved.missing.map(id => "evidence_missing:" + id)];
    if (problems.length) { stopped.push({ candidate, reason: problems.join(",") }); continue; }
    // 送信する本文・順序まで確定してからhashを作る。
    const inputHash = await sha256(JSON.stringify({ question: candidate.question, history: candidate.history,
      evidence: resolved.items.map(item => ({ id: item.id, kind: item.kind, title: item.title, text: item.text, order: item.order })),
      candidate: candidate.payload }));
    const existing = byInput.get(inputHash);
    if (existing) { existing.sourceRefs.push(...consistent); continue; }
    byInput.set(inputHash, { ...candidate, sourceRefs: [...consistent], items: resolved.items, problems: [],
      inputHash, evidenceFidelity: consistent.length === candidate.sourceRefs.length && !candidate.inputProblem
        ? candidate.evidenceFidelity : "saved_evidence_ids_only" });
  }
  return { candidates: [...byInput.values()], stopped };
}

// 段階C: 実行入口を1か所にまとめ、呼び出し回数を実行境界で数える。
// 停止した候補は runner を呼ばない（両API 0回）。
export async function runComparisons(input: {
  candidates: FinalCandidate[]; limit: number;
  runner: (candidate: FinalCandidate) => Promise<void>;
}): Promise<{ ran: number; skipped: number }> {
  let ran = 0, skipped = 0;
  for (const candidate of input.candidates.slice(0, input.limit)) {
    if (candidate.problems.length) { skipped += 1; continue; }
    await input.runner(candidate);
    ran += 1;
  }
  return { ran, skipped };
}
