// 通信しない範囲の試験。実APIの品質は別途、人手ラベルで確認する。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAnswerInput, filterEvidence, loadCases, loadHistories, loadProfile, promptVersion, selectCases } from "../src/lab.mts";
import { assertAllowedHost, classifyHttp, parseAnswer, type ProviderConfig } from "../src/provider.mts";
import { appendRecord, percentile, readRecords, summarize, updateLabel } from "../src/records.mts";
import { runCaseA } from "../src/run.mts";
import type { RunRecord } from "../src/types.mts";

const profile = loadProfile();
const cases = loadCases();

test("承認・公開・対象者・現行版の条件で根拠を絞り、使えない理由を残す", () => {
  const { usable, excluded } = filterEvidence(profile, ["ev-a1", "ev-x1", "ev-x2", "ev-x3", "ev-x4", "ev-x5", "unknown-id"]);
  assert.deepEqual(usable.map(unit => unit.id), ["ev-a1"]);
  assert.deepEqual(excluded, [
    { id: "ev-x1", reason: "unapproved" },
    { id: "ev-x2", reason: "revoked" },
    { id: "ev-x3", reason: "private" },
    { id: "ev-x4", reason: "other_subject" },
    { id: "ev-x5", reason: "stale_revision" },
    { id: "unknown-id", reason: "not_found" }
  ]);
});

test("選択していない根拠はモデルへ渡さない", () => {
  for (const item of cases) {
    const { usable } = filterEvidence(profile, item.selection);
    const input = buildAnswerInput(item, loadHistories()[item.historyId ?? ""] ?? [], usable);
    const body = input.system + input.user;
    for (const unit of profile.evidence) {
      if (item.selection.includes(unit.id)) continue;
      assert.equal(body.includes(unit.text), false, item.id + " は " + unit.id + " を送らない");
    }
  }
});

test("採点用のgoldを生成の入力へ含めない", () => {
  for (const item of cases) {
    const { usable } = filterEvidence(profile, item.selection);
    const input = buildAnswerInput(item, [], usable);
    const body = input.system + input.user;
    assert.equal(body.includes("mustNot"), false, item.id);
    assert.equal(body.includes("mustInclude"), false, item.id);
    for (const text of [...item.gold.mustInclude, ...item.gold.mustNot]) {
      assert.equal(body.includes(text), false, item.id + " のgold: " + text);
    }
  }
});

test("非公開の根拠はT10でも送らない", () => {
  const item = selectCases(["T10"])[0];
  const { usable, excluded } = filterEvidence(profile, item.selection);
  assert.deepEqual(usable.map(unit => unit.id), ["ev-a1"]);
  assert.deepEqual(excluded, [{ id: "ev-x3", reason: "private" }]);
  const input = buildAnswerInput(item, [], usable);
  assert.equal(input.user.includes("PRIVATE-MARKER-9F3"), false);
});

test("プロンプト版は指示とschemaから決まる固定の識別子", () => {
  assert.match(promptVersion, /^[0-9a-f]{8}$/);
});

test("応答の形を確認し、壊れたJSONは受け付けない", () => {
  assert.deepEqual(parseAnswer('{"answer":"a","sourceIds":["ev-a1"],"limitations":""}'),
    { answer: "a", sourceIds: ["ev-a1"], limitations: "" });
  for (const broken of ["", "not json", "[]", '{"answer":1}', '{"answer":"a"}', '{"answer":"a","sourceIds":[1],"limitations":""}'])
    assert.equal(parseAnswer(broken), null, broken);
});

test("HTTPの失敗と接続先の制限を固定の識別子で扱う", () => {
  assert.equal(classifyHttp(400), "http_400");
  assert.equal(assertAllowedHost("https://opencode.ai/zen/go/v1", ["opencode.ai"]), "opencode.ai");
  assert.throws(() => assertAllowedHost("https://example.com/v1", ["opencode.ai"]), /host_not_allowed/);
  assert.throws(() => assertAllowedHost("not a url", ["opencode.ai"]), /invalid_base_url/);
});

test("記録の追記・読み出し・ラベル更新", () => {
  const dir = mkdtempSync(join(tmpdir(), "lab-"));
  try {
    const path = join(dir, "records.jsonl");
    const record = sampleRecord("run-1");
    appendRecord(path, record);
    appendRecord(path, sampleRecord("run-2"));
    assert.equal(readRecords(path).length, 2);
    assert.equal(updateLabel(path, "run-1", { targetMatch: "ok", aspectMatch: "ok", supported: "ng", notes: "主体が違う", at: "now" }), true);
    const updated = readRecords(path).find(item => item.runId === "run-1");
    assert.equal(updated?.label?.supported, "ng");
    assert.equal(updateLabel(path, "missing", { targetMatch: "?", aspectMatch: "?", supported: "?", notes: "", at: "now" }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("集計は欠測を推定で埋めず、件数と一緒に返す", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([100, 200, 300, 400], 0.5), 300);
  const records = [sampleRecord("a"), sampleRecord("b"), { ...sampleRecord("c"), status: "error" as const, errorKind: "timeout", usage: { inputTokens: null, outputTokens: null } }];
  const summary = summarize(records);
  assert.equal(summary.total, 3);
  assert.equal(summary.ok, 2);
  assert.deepEqual(summary.errors, { timeout: 1 });
  assert.equal(summary.apiCalls, 3);
  assert.equal(summary.usage.withUsage, 2, "usageが無い記録は平均の分母に入れない");
});

const config: ProviderConfig = { baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "test-key", model: "test-model",
  session: "lab-test", temperature: 0, maxTokens: 256, timeoutMs: 5_000 };

test("タイムアウトは処理失敗として記録し、情報不足にしない", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = ((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  })) as unknown as typeof fetch;
  try {
    const record = await runCaseA(selectCases(["T13"])[0], config);
    assert.equal(record.status, "error");
    assert.equal(record.errorKind, "timeout");
    assert.equal(record.answer, "");
    assert.equal(record.apiCalls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("HTTPエラーは応答コードの識別子で記録する", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch;
  try {
    const record = await runCaseA(selectCases(["T01"])[0], config);
    assert.equal(record.status, "error");
    assert.equal(record.errorKind, "http_400");
    assert.deepEqual(record.sentEvidenceIds, ["ev-a1", "ev-a2", "ev-a3"]);
  } finally {
    globalThis.fetch = original;
  }
});

function sampleRecord(runId: string): RunRecord {
  return {
    runId, at: "2026-09-17T00:00:00.000Z", baseSha: "test", phase: "phase1", mode: "A", caseId: "T01",
    question: "q", historyId: null, selection: ["ev-a1"], sentEvidenceIds: ["ev-a1"], excluded: [],
    provider: "https://opencode.ai/zen/go/v1", model: "m", temperature: 0, maxTokens: 256, promptVersion: "00000000",
    status: "ok", errorKind: null, answer: "a", sourceIds: ["ev-a1"], limitations: "",
    timing: { apiStartMs: 10, firstTokenMs: 20, completeMs: 100, totalMs: 100 },
    usage: { inputTokens: 1000, outputTokens: 100 }, apiCalls: 1, label: null
  };
}
