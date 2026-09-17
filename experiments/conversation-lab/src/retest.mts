// 指示書2026-09-18の再試験: A（人が選んだ根拠＋短い指示＋単発生成）、
// B（現行検索＋Aと同じ短い指示）、C（Bの根拠を固定＋現行の生成・機械確認・校閲・修復）。
// 採点と速度を別フィールドで記録し、条件ごとの実行順・同一スナップショットを残す。
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { answerSystem, promptVersion as labPromptVersion } from "./lab.mts";
import { callAnswer, type ProviderConfig } from "./provider.mts";
import { FrozenRepository, buildSnapshot, hideMemo, resolveRefs, retrieveForLab, type Snapshot } from "./snapshot.mts";
import { answer as appAnswer } from "../../../lib/answer/engine.ts";
import { OpenCodeProvider } from "../../../lib/ai/opencode.ts";
import { promptVersion as appPromptVersion } from "../../../lib/ai/prompt.ts";
import type { KnowledgeRepository } from "../../../lib/knowledge/repository.ts";
import type { AnswerProvider, Evidence, Turn } from "../../../lib/types.ts";

export type Condition = "A" | "B" | "C";

export interface RetestCase {
  id: string;
  kind: "main" | "separate";
  question: string;
  history: Turn[];
  anaphoraTarget: string | null;
  targetPeriod: string | null;
  expected: "answerable" | "partial" | "insufficient" | "ambiguous" | "refused";
  evidenceKind: string;
  evidenceRefs: { doc: string; title: string }[];
  requiredClaims: string[];
  allowedLimitations: string[];
  forbiddenClaims: string[];
}

export interface RetestRecord {
  runId: string;
  at: string;
  condition: Condition;
  repeat: number;
  order: number;
  caseId: string;
  kind: string;
  question: string;
  history: Turn[];
  anaphoraTarget: string | null;
  targetPeriod: string | null;
  expected: string;
  evidenceKind: string;
  humanCriteria: { requiredClaims: string[]; allowedLimitations: string[]; forbiddenClaims: string[] };
  evidenceRefs: { id: string; title: string }[];
  manifest: Record<string, string | number | boolean | null>;
  execution: { status: "ok" | "error"; errorKind: string | null; apiCalls: number };
  modelAnswerability: string | null;
  fetchedBy: "human" | "retrieval" | "frozen";
  evidenceIds: string[];
  frozenFromRunId: string | null;
  answer: string;
  answerStatus: "answered" | "limited" | "no_answer";
  stage: { retrievalMs: number | null; generationMs: number[]; verificationMs: number[]; ttftMs: number | null;
    firstDisplayableMs: number | null; completeMs: number | null; totalMs: number };
  usage: { inputTokens: number | null; outputTokens: number | null; verificationInputTokens: number | null };
  pipelineLog: { candidate1: string | null; mechanicalCheck: string | null; verificationReasons: string[];
    repairedCandidate: string | null; diagnostics: { code: string; reason?: string; latencyMs?: number; inputTokens?: number; outputTokens?: number }[] };
  humanLabel: { semanticLabel: string; factuality: string; relevance: string; privacyPass: string; notes: string; at: string } | null;
}

export function loadRetestCases(): RetestCase[] {
  return (JSON.parse(readFileSync(new URL("../data/cases-v2.json", import.meta.url), "utf8")) as { cases: RetestCase[] }).cases;
}

export function baseSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

// AとBで同じ短い指示を使う。根拠は見出しと本文を渡す。
function labInput(question: string, history: Turn[], items: { id: string; title: string; text: string }[]) {
  return {
    system: answerSystem,
    user: JSON.stringify({ question, history,
      evidence: items.map(item => ({ id: item.id, title: item.title, text: item.text })) })
  };
}

function itemsFor(snapshot: Snapshot, ids: string[]) {
  return ids.map(id => snapshot.chunks.find(chunk => chunk.id === id))
    .filter((chunk): chunk is NonNullable<typeof chunk> => !!chunk)
    .map(chunk => ({ id: chunk.id, title: chunk.title, text: chunk.content }));
}

function emptyRecord(item: RetestCase, condition: Condition): RetestRecord {
  return {
    runId: randomUUID(), at: new Date().toISOString(), condition, repeat: 0, order: 0,
    caseId: item.id, kind: item.kind, question: item.question, history: item.history,
    anaphoraTarget: item.anaphoraTarget, targetPeriod: item.targetPeriod, expected: item.expected,
    evidenceKind: item.evidenceKind,
    humanCriteria: { requiredClaims: item.requiredClaims, allowedLimitations: item.allowedLimitations, forbiddenClaims: item.forbiddenClaims },
    evidenceRefs: [], manifest: {}, execution: { status: "ok", errorKind: null, apiCalls: 0 },
    modelAnswerability: null, fetchedBy: "human", evidenceIds: [], frozenFromRunId: null,
    answer: "", answerStatus: "no_answer",
    stage: { retrievalMs: null, generationMs: [], verificationMs: [], ttftMs: null, firstDisplayableMs: null, completeMs: null, totalMs: 0 },
    usage: { inputTokens: null, outputTokens: null, verificationInputTokens: null },
    pipelineLog: { candidate1: null, mechanicalCheck: null, verificationReasons: [], repairedCandidate: null, diagnostics: [] },
    humanLabel: null
  };
}

function answerStatusOf(answer: string, limitations: string): "answered" | "limited" | "no_answer" {
  if (answer.trim()) return limitations.trim() ? "limited" : "answered";
  return "no_answer";
}

function manifestFor(snapshot: Snapshot, config: ProviderConfig, extra: { evidenceSource: string }) {
  return {
    baseSha: baseSha(),
    snapshotHash: snapshot.hash,
    snapshotChunks: snapshot.chunks.length,
    provider: config.baseUrl,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    timeoutMs: config.timeoutMs,
    labPromptVersion: labPromptVersion,
    appPromptVersion: appPromptVersion,
    study: "retest-20260918",
    evidenceSource: extra.evidenceSource,
    embedding: extra.evidenceSource === "frozen" ? "not_used" : "lab_hash_bigram(本番はbge-m3+Vectorize)",
    retrievalNote: extra.evidenceSource === "frozen" ? "Bの取得根拠を固定" : "現行検索コード・ローカルSQLite(FTS5)"
  };
}

// A条件: 人が選んだ根拠（ケースのevidenceRefs）＋短い指示＋1回生成。
export async function runA(item: RetestCase, snapshot: Snapshot, config: ProviderConfig,
  meta: { repeat: number; order: number }): Promise<RetestRecord> {
  const record = emptyRecord(item, "A");
  record.repeat = meta.repeat; record.order = meta.order;
  const refs = resolveRefs(snapshot, item.evidenceRefs);
  record.evidenceRefs = refs;
  record.evidenceIds = refs.map(ref => ref.id);
  record.fetchedBy = "human";
  record.manifest = manifestFor(snapshot, config, { evidenceSource: "hand_selected" });
  const input = labInput(item.question, item.history, itemsFor(snapshot, record.evidenceIds));
  const started = performance.now();
  const result = await callAnswer(input.system, input.user, config);
  record.execution.apiCalls = 1;
  record.stage.ttftMs = result.timing.firstTokenMs;
  record.stage.completeMs = result.timing.completeMs;
  record.stage.totalMs = Math.round(performance.now() - started);
  record.stage.generationMs = [record.stage.totalMs];
  record.stage.firstDisplayableMs = record.stage.totalMs;
  if (!result.ok) {
    record.execution.status = "error"; record.execution.errorKind = result.errorKind;
    return record;
  }
  record.answer = result.payload.answer;
  record.modelAnswerability = result.payload.limitations ? "partial" : "answerable";
  record.usage = { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, verificationInputTokens: null };
  record.answerStatus = answerStatusOf(result.payload.answer, result.payload.limitations);
  return record;
}

// B条件: 現行の初回検索で根拠を取得し、Aと同じ短い指示で1回生成する。
export async function runB(item: RetestCase, snapshot: Snapshot, config: ProviderConfig,
  meta: { repeat: number; order: number }): Promise<RetestRecord> {
  const record = emptyRecord(item, "B");
  record.repeat = meta.repeat; record.order = meta.order;
  record.manifest = manifestFor(snapshot, config, { evidenceSource: "retrieval" });
  const retrieval = await retrieveForLab({ snapshot, question: item.question, history: item.history });
  record.stage.retrievalMs = retrieval.latencyMs;
  record.evidenceIds = retrieval.evidence.map(evidence => evidence.id);
  record.evidenceRefs = retrieval.evidence.map(evidence => ({ id: evidence.id, title: evidence.title }));
  record.fetchedBy = "retrieval";
  const input = labInput(item.question, item.history, itemsFor(snapshot, record.evidenceIds));
  const started = performance.now();
  const result = await callAnswer(input.system, input.user, config);
  record.execution.apiCalls = 1;
  record.stage.ttftMs = result.timing.firstTokenMs;
  record.stage.completeMs = result.timing.completeMs;
  record.stage.totalMs = Math.round(performance.now() - started);
  record.stage.generationMs = [record.stage.totalMs];
  record.stage.firstDisplayableMs = record.stage.totalMs;
  if (!result.ok) {
    record.execution.status = "error"; record.execution.errorKind = result.errorKind;
    return record;
  }
  record.answer = result.payload.answer;
  record.modelAnswerability = result.payload.limitations ? "partial" : "answerable";
  record.usage = { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, verificationInputTokens: null };
  record.answerStatus = answerStatusOf(result.payload.answer, result.payload.limitations);
  return record;
}

// 提供元を包み、生成候補（初回・修復後）をローカルの記録へ残す。
function wrapProvider(provider: AnswerProvider, log: { purpose: string; payload: unknown }[]): AnswerProvider {
  return {
    ...provider,
    async *stream(input: Parameters<AnswerProvider["stream"]>[0], signal: AbortSignal) {
      for await (const output of provider.stream(input, signal)) {
        if (output.type === "complete") log.push({ purpose: input.purpose ?? "answer", payload: output.payload });
        yield output;
      }
    }
  } as AnswerProvider;
}

// C条件: Bで取得した根拠を固定し、現行の生成・機械確認・校閲・修復を再現する。
export async function runC(item: RetestCase, snapshot: Snapshot, config: ProviderConfig,
  frozen: { evidence: Evidence[]; fromRunId: string | null },
  meta: { repeat: number; order: number }): Promise<RetestRecord> {
  const record = emptyRecord(item, "C");
  record.repeat = meta.repeat; record.order = meta.order;
  record.manifest = manifestFor(snapshot, config, { evidenceSource: "frozen" });
  record.fetchedBy = "frozen";
  record.frozenFromRunId = frozen.fromRunId;
  record.evidenceIds = frozen.evidence.map(evidence => evidence.id);
  record.evidenceRefs = frozen.evidence.map(evidence => ({ id: evidence.id, title: evidence.title }));
  const repository = new FrozenRepository("fictional-minato", frozen.evidence) as unknown as KnowledgeRepository;
  const log: { purpose: string; payload: unknown }[] = [];
  const provider = wrapProvider(new OpenCodeProvider(config.apiKey, config.model,
    process.env.LAB_OPENCODE_JSON_MODE === "object" ? "object" : "schema", config.session), log);
  const diagnostics: RetestRecord["pipelineLog"]["diagnostics"] = [];
  const started = performance.now();
  let finalText = "";
  let state: string | null = null;
  let errorKind: string | null = null;
  try {
    for await (const event of appAnswer({ mode: "meeting_text", message: item.question, history: item.history },
      { repository, vector: snapshot.vector, embedding: snapshot.embedding, provider,
        diagnostics: value => diagnostics.push({ code: value.code, reason: value.reason, latencyMs: value.latencyMs,
          inputTokens: value.inputTokens, outputTokens: value.outputTokens }),
        timeBudgetMs: config.timeoutMs },
      AbortSignal.timeout(config.timeoutMs))) {
      if (event.type === "text") finalText += event.text;
      if (event.type === "done") state = event.answerability;
      if (event.type === "error") errorKind = event.code;
    }
  } catch (error) {
    errorKind = error instanceof Error ? error.message.slice(0, 40) : "unknown";
  }
  record.stage.totalMs = Math.round(performance.now() - started);
  record.stage.firstDisplayableMs = record.stage.totalMs;
  record.stage.completeMs = record.stage.totalMs;
  const generations = diagnostics.filter(item => item.code === "generation_complete");
  const verifications = diagnostics.filter(item => item.code === "verification_complete");
  record.stage.generationMs = generations.map(item => item.latencyMs ?? 0);
  record.stage.verificationMs = verifications.map(item => item.latencyMs ?? 0);
  record.modelAnswerability = state;
  record.answer = finalText;
  record.execution.status = errorKind && !finalText ? "error" : "ok";
  record.execution.errorKind = errorKind;
  record.execution.apiCalls = log.length;
  const candidates = log.filter(entry => entry.purpose === "answer");
  record.pipelineLog.candidate1 = candidates[0] ? JSON.stringify(candidates[0].payload) : null;
  record.pipelineLog.repairedCandidate = candidates[1] ? JSON.stringify(candidates[1].payload) : null;
  record.pipelineLog.mechanicalCheck = diagnostics
    .filter(item => item.code === "unsupported_claim" || item.code === "verification_rejected" || item.code === "length_exceeded")
    .map(item => item.code + (item.reason ? ":" + item.reason : "")).join(",") || null;
  record.pipelineLog.verificationReasons = verifications.map(item => item.reason ?? "");
  record.pipelineLog.diagnostics = diagnostics;
  const sum = (values: (number | undefined)[]) => {
    const picked = values.filter((value): value is number => typeof value === "number");
    return picked.length ? picked.reduce((left, right) => left + right, 0) : null;
  };
  record.usage = {
    inputTokens: sum(generations.map(item => item.inputTokens)),
    outputTokens: sum(generations.map(item => item.outputTokens)),
    verificationInputTokens: sum(verifications.map(item => item.inputTokens))
  };
  record.answerStatus = finalText ? (state === "partial" ? "limited" : "answered") : "no_answer";
  return record;
}

// 条件とケースの実行順を作る（ケースごとに交互、またはランダム）。
export function buildRunPlan(cases: RetestCase[], conditions: Condition[], repeat: number,
  order: "interleave" | "random"): { caseId: string; condition: Condition; repeat: number }[] {
  const plan: { caseId: string; condition: Condition; repeat: number }[] = [];
  for (let round = 1; round <= repeat; round += 1) {
    for (const item of cases) for (const condition of conditions) plan.push({ caseId: item.id, condition, repeat: round });
  }
  if (order === "random") {
    for (let index = plan.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      const held = plan[index]; plan[index] = plan[swap]; plan[swap] = held;
    }
  }
  return plan;
}

export async function prepareSnapshotForRetest(options: { vectorChannel?: boolean } = {}): Promise<Snapshot> {
  const snapshot = await buildSnapshot(options);
  await hideMemo(snapshot);
  return snapshot;
}

// Bの取得根拠を、Cへ渡す正規のEvidenceとして読み直す（owner・承認・公開の門を通す）。
export async function loadFrozenEvidence(snapshot: Snapshot, ids: string[]): Promise<Evidence[]> {
  if (!ids.length) return [];
  return snapshot.repository.resolve(ids);
}

// 再試験の記録は専用のJSONLへ追記する（公開対象外の .local 配下）。
export function defaultRetestPath(): string {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  return root + ".local/conversation-lab/retest.jsonl";
}

export function appendRetestRecord(path: string, record: RetestRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + String.fromCharCode(10), "utf8");
}
