// 4-1のオフライン検証: 根拠の受け渡し形式・送信直前の公開確認・モデルへ渡る本文。
// 外部APIは呼ばない。
import test from "node:test";
import assert from "node:assert/strict";
import { assertPublicNow, handoffBody, handoffSummary, inspectModelInput, toEvidence, toHandoff } from "../src/handoff.mts";
import { buildSnapshot, hideMemo, retrieveForLab } from "../src/snapshot.mts";
import { loadRetestCases, resolveHandoff, runC } from "../src/retest.mts";
import type { AnswerProvider } from "../../../lib/types.ts";

test("チャンクとFactを同じ形式へ写し、往復しても本文と種類が変わらない", async () => {
  const snapshot = await buildSnapshot();
  const retrieval = await retrieveForLab({ snapshot, question: "会社員時代と独立後で、担当はどう変わりましたか？", history: [] });
  const items = toHandoff(retrieval.evidence);
  assert.ok(items.some(item => item.kind === "fact"), "Factが含まれる");
  assert.ok(items.some(item => item.kind === "chunk"), "チャンクが含まれる");
  const round = toHandoff(toEvidence(items));
  assert.deepEqual(round.map(item => [item.id, item.kind, item.text]), items.map(item => [item.id, item.kind, item.text]));
});

test("M01の根拠参照は、会社員2社のFactとチャンクの両方を解決する", async () => {
  const snapshot = await buildSnapshot();
  const item = loadRetestCases().find(value => value.id === "M01")!;
  const items = resolveHandoff(snapshot, item.evidenceRefs);
  assert.equal(items.filter(entry => entry.kind === "fact").length, 2, "Fact2件");
  assert.equal(items.filter(entry => entry.kind === "chunk").length, 2, "チャンク2件");
  const body = handoffBody({ question: item.question, history: item.history, items });
  for (const needle of ["アルファ電子で車載機器の保守", "ベータ商事でカスタマーサポートのスーパーバイザー"]) {
    assert.ok(body.includes(needle), needle + " が本文へ入る");
  }
});

test("送信直前の確認は、Factを落とさずに通し、非公開になったチャンクは落とす", async () => {
  const snapshot = await buildSnapshot();
  const item = loadRetestCases().find(value => value.id === "M01")!;
  const items = resolveHandoff(snapshot, item.evidenceRefs);
  const before = await assertPublicNow(snapshot.repository, items);
  assert.equal(before.kept.length, 4, "Factもチャンクも残る");
  assert.deepEqual(before.dropped, []);
  const memoChunk = snapshot.chunks.find(chunk => chunk.title.includes("価格改定"))!;
  const withMemo = [...items, { ...items[0], id: memoChunk.id, kind: "chunk" as const, title: memoChunk.title,
    text: memoChunk.content, revisionId: memoChunk.revisionId, documentId: memoChunk.documentId, contentHash: memoChunk.contentHash }];
  await hideMemo(snapshot);
  const after = await assertPublicNow(snapshot.repository, withMemo);
  assert.equal(after.kept.length, 4, "現行の根拠は残る");
  assert.deepEqual(after.dropped, [{ id: memoChunk.id, reason: "not_current_or_not_public" }], "非公開になったチャンクだけ落ちる");
  assert.equal(after.kept.some(entry => entry.id === memoChunk.id), false);
  assert.ok(after.kept.some(entry => entry.kind === "fact"), "Factは残る");
});

test("モデルへ渡る本文の検査は、欠落と本文の食い違いを見つける", async () => {
  const snapshot = await buildSnapshot();
  const item = loadRetestCases().find(value => value.id === "M01")!;
  const items = resolveHandoff(snapshot, item.evidenceRefs);
  const body = handoffBody({ question: item.question, history: item.history, items });
  assert.ok(body.includes(items[2].text), "Factの本文が本文へ入る");
  const short = items.slice(0, 3);
  const inspection = inspectModelInput(toEvidence(short), items);
  assert.deepEqual(inspection.missingInPrompt, [items[3].id], "渡していないIDを検出する");
  const changed = toEvidence(items.map((entry, index) => index === 0 ? { ...entry, text: entry.text + "（改変）" } : entry));
  assert.deepEqual(inspectModelInput(changed, items).textMismatch, [items[0].id], "本文の食い違いを検出する");
});

test("Bの取得根拠は、Factを含めてそのままCへ渡せる形で保存できる", async () => {
  const snapshot = await buildSnapshot();
  const retrieval = await retrieveForLab({ snapshot, question: "会社員時代と独立後で、担当はどう変わりましたか？", history: [] });
  const checked = await assertPublicNow(snapshot.repository, toHandoff(retrieval.evidence));
  const summary = handoffSummary(checked.kept);
  assert.equal(summary.ids.length, checked.kept.length);
  assert.equal(summary.textHashes.length, checked.kept.length);
  assert.ok(summary.kinds.includes("fact"), "Factの種類を保存する");
});

test("Cは固定したFactを含む本文を、実際にモデルへ渡す（モックで確認・外部APIなし）", async () => {
  const snapshot = await buildSnapshot();
  const item = loadRetestCases().find(value => value.id === "M01")!;
  const items = resolveHandoff(snapshot, item.evidenceRefs);
  const seen: string[][] = [];
  const stub = {
    async *stream(input: Parameters<AnswerProvider["stream"]>[0]) {
      seen.push(input.evidence.map(entry => entry.id));
      throw new Error("stub_stop");
    }
  } as unknown as AnswerProvider;
  const config = { baseUrl: "https://example.invalid/v1", apiKey: "none", model: "stub", session: "stub",
    temperature: 0, maxTokens: 64, timeoutMs: 5_000 };
  const record = await runC(item, snapshot, config, { items, fromRunId: null }, { repeat: 1, order: 1 }, { provider: stub });
  assert.ok(seen.length > 0, "生成が呼ばれる");
  for (const entry of items) assert.ok(seen[0].includes(entry.id), entry.id + " がモデル入力へ入る");
  assert.deepEqual(record.handoff.missingInPrompt, [], "固定根拠の欠落なし");
  assert.equal(record.handoff.modelInputIds.length, items.length);
});
