// 手動テストは一問ずつ。既存のB/C処理を使い、Dの保存候補評価とは別に記録する。
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadRetestCases, prepareSnapshotForRetest, runB, runC, appendRetestRecord, type RetestCase } from "./retest.mts";
import { retrieveForLab, type Snapshot } from "./snapshot.mts";
import { assertPublicNow, toHandoff } from "./handoff.mts";
import { callAnswer, type ProviderConfig } from "./provider.mts";
import { OpenCodeProvider } from "../../../lib/ai/opencode.ts";
import type { AnswerProvider } from "../../../lib/types.ts";

export const manualEndpoint = "https://opencode.ai/zen/go/v1";
export const manualRecordsPath = process.env.LAB_MANUAL_RECORDS ?? fileURLToPath(new URL("../../../.local/conversation-lab/manual.jsonl", import.meta.url));
const jevRecordsPath = fileURLToPath(new URL("../../../.local/conversation-lab/jev.jsonl", import.meta.url));
export const manualModes = [
  { id: "B", label: "B：軽量（現行検索＋1回生成）", calls: 1,
    description: "架空資料を現行の検索コードで探し、短い指示で1回生成します。LLM校閲・修復は行いません。" },
  { id: "C", label: "C：現行処理（検索＋生成・校閲・修復）", calls: 6,
    description: "同じ検索コードで得た根拠を固定し、現行の生成・機械確認・LLM校閲・修復を実行します。必要に応じて複数回呼び出します。" }
];
export interface ManualPlan {
  id: string;
  mode: "B" | "C";
  item: RetestCase;
  endpoint: string;
  model: string;
  maxCalls: number;
  at: number;
}
let snapshotPromise: Promise<Snapshot> | undefined;
const snapshotForManual = () => snapshotPromise ??= prepareSnapshotForRetest();

export function createManualPlan(body: Record<string, unknown>, config: ProviderConfig): ManualPlan {
  if (config.baseUrl !== manualEndpoint) throw new Error("endpoint_mismatch");
  if (body.mode !== "B" && body.mode !== "C") throw new Error("invalid_mode");
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question || question.length > 2000) throw new Error("invalid_question");
  const preset = loadRetestCases().find(item => item.id === body.caseId);
  if (body.caseId && !preset) throw new Error("invalid_case");
  // 採点用の期待値は自由入力に流用しない。履歴は選択した架空ケースのみ。
  const item: RetestCase = { id: preset?.id ?? "manual", kind: "main", question,
    history: preset?.history ?? [], anaphoraTarget: null, targetPeriod: null, expected: "ambiguous",
    evidenceKind: "manual_unscored", evidenceRefs: [], requiredClaims: [], allowedLimitations: [], forbiddenClaims: [] };
  return { id: randomUUID(), mode: body.mode, item, endpoint: config.baseUrl, model: config.model,
    maxCalls: body.mode === "B" ? 1 : 6, at: Date.now() };
}

export async function manualState() {
  const snapshot = await snapshotForManual();
  return { profile: "架空人物・ミナト（fictional-minato）", modes: manualModes,
    cases: loadRetestCases().map(({ id, question, history }) => ({ id, question, history })),
    documents: snapshot.chunks.map(({ title, content }) => ({ title, content })) };
}

export async function executeManualPlan(plan: ManualPlan, config: ProviderConfig, signal: AbortSignal,
  options: { provider?: AnswerProvider; call?: typeof callAnswer } = {}) {
  if (plan.endpoint !== manualEndpoint || config.baseUrl !== plan.endpoint || config.model !== plan.model) throw new Error("configuration_changed");
  signal.throwIfAborted();
  const snapshot = await snapshotForManual();
  let calls = 0;
  const started = performance.now();
  const call = options.call ?? callAnswer;
  let record;
  if (plan.mode === "B") {
    record = await runB(plan.item, snapshot, config, { repeat: 1, order: 1 }, undefined, {
      call: async (system, user, settings) => {
        signal.throwIfAborted();
        calls += 1;
        return call(system, user, settings, signal);
      }
    });
  } else {
    const retrieval = await retrieveForLab({ snapshot, question: plan.item.question, history: plan.item.history });
    const checked = await assertPublicNow(snapshot.repository, toHandoff(retrieval.evidence));
    const base = options.provider ?? new OpenCodeProvider(config.apiKey, config.model,
      process.env.LAB_OPENCODE_JSON_MODE === "object" ? "object" : "schema", config.session);
    const provider: AnswerProvider = {
      async *stream(input, engineSignal) {
        signal.throwIfAborted();
        if (calls >= plan.maxCalls) throw new Error("manual_call_limit");
        calls += 1; // エラーも含め、送信を試みた回数を数える。
        yield* base.stream(input, AbortSignal.any([signal, engineSignal]));
      }
    };
    record = await runC(plan.item, snapshot, config, { items: checked.kept, fromRunId: null },
      { repeat: 1, order: 1 }, { provider });
    record.stage.retrievalMs = retrieval.latencyMs;
    record.handoff.dropped = checked.dropped;
  }
  record.execution.apiCalls = calls;
  if (signal.aborted) {
    record.execution.status = "error";
    record.execution.errorKind = "aborted_or_timed_out";
  }
  record.stage.totalMs = Math.round(performance.now() - started);
  record.manifest = { ...record.manifest, study: "manual-test", profile: "fictional-minato",
    entrypoint: plan.mode === "B" ? "runB" : "retrieveForLab+runC", apiCallLimit: plan.maxCalls };
  return record;
}

export function saveManualRecord(record: Awaited<ReturnType<typeof executeManualPlan>>) {
  appendRetestRecord(manualRecordsPath, record);
}

export function readManualRecords() {
  if (!existsSync(manualRecordsPath)) return [];
  return readFileSync(manualRecordsPath, "utf8").trim().split("\n").filter(Boolean).slice(-30).map(line => JSON.parse(line));
}

export function savedJevResults() {
  if (!existsSync(jevRecordsPath)) return [];
  // 新形式の既存結果だけを閲覧する。旧parserの記録は混ぜず、元ファイルは書き換えない。
  return readFileSync(jevRecordsPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
    .filter(row => row.current?.executionStatus && row.jev?.executionStatus).slice(-20)
    .map(row => ({ compareId: row.compareId, at: row.at, caseId: row.caseId, question: row.question,
      candidateKind: row.candidateKind, structuredCandidate: row.structuredCandidate,
      baseSha: row.baseSha, judgeDefinitionHash: row.judgeDefinitionHash,
      current: row.current, jev: row.jev, notes: row.notes, implementationNote: row.implementationNote }));
}
