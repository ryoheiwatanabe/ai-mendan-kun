// 4-1/4-2の回帰: 根拠の受け渡しの同一性、Factの脱落防止、保存候補の機械確認、状態分岐。
// すべてオフラインで、外部APIを呼ばない。
import test from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, retrieveForLab } from "../src/snapshot.mts";
import { loadRetestCases, resolveHandoff, runB, runC } from "../src/retest.mts";
import { toHandoff } from "../src/handoff.mts";
import { validateSegment } from "../../../lib/answer/guard.ts";
import type { AnswerProvider, Evidence, Segment } from "../../../lib/types.ts";

const config = { baseUrl: "https://example.invalid/v1", apiKey: "none", model: "stub", session: "stub",
  temperature: 0, maxTokens: 64, timeoutMs: 5_000 };

function stubProvider(onCall: (evidence: Evidence[]) => void): AnswerProvider {
  return {
    async *stream(input: Parameters<AnswerProvider["stream"]>[0]) { onCall(input.evidence); throw new Error("stub_stop"); }
  } as unknown as AnswerProvider;
}

test("BとCは、同じ根拠本文・順序・履歴を受け取る", async () => {
  const snapshot = await buildSnapshot();
  const item = loadRetestCases().find(value => value.id === "M01")!;
  const bodies: string[] = [];
  const store = new Map<string, ReturnType<typeof resolveHandoff>>();
  const recordB = await runB(item, snapshot, config, { repeat: 1, order: 1 }, store,
    { call: (async (_system: string, user: string) => { bodies.push(user); return { ok: false, errorKind: "stub_stop", timing: { apiStartMs: 0, firstTokenMs: null, completeMs: null, totalMs: 0 }, usage: { inputTokens: null, outputTokens: null } }; }) as never });
  const frozen = store.get(item.id)!;
  assert.ok(frozen.length >= 3, "Bの取得根拠を保持する（Factを含む）");
  assert.deepEqual(recordB.handoff.missingInPrompt, [], "取得した根拠は本文へ展開される");
  const bodyB = JSON.parse(bodies[0]) as { evidence: { id: string; text: string }[] };
  const sentC: Evidence[][] = [];
  const recordC = await runC(item, snapshot, config, { items: frozen, fromRunId: recordB.runId }, { repeat: 1, order: 1 },
    { provider: stubProvider(evidence => sentC.push(evidence)) });
  assert.ok(sentC.length > 0, "Cの生成が呼ばれる");
  const sentIds = sentC[0].map(entry => entry.id);
  const frozenIds = frozen.map(entry => entry.id);
  const bodyIds = bodyB.evidence.map(entry => entry.id);
  assert.deepEqual(sentIds.slice().sort(), bodyIds.slice().sort(),
    "根拠集合が一致する: frozen=" + JSON.stringify(frozenIds) + " B=" + JSON.stringify(bodyIds) + " C=" + JSON.stringify(sentIds));
  const sentText = new Map(sentC[0].map(entry => [entry.id, entry.content]));
  for (const entry of frozen) {
    const sent = sentText.get(entry.id);
    assert.ok(typeof sent === "string", entry.id + " がモデル入力にある");
    if (entry.kind === "fact") assert.equal(sent, entry.text, "Factは本文一致する");
    // チャンクは、Factと重複する文をアプリが取り除くため、本文が短くなることがある（包含で確認する）。
    else assert.ok(entry.text.includes(sent), entry.id + " の本文が保持される: " + JSON.stringify({ frozen: entry.text, sent }));
  }
  assert.deepEqual(bodyB.evidence.map(entry => entry.text), frozen.map(entry => entry.text), "Bの本文展開も固定根拠と一致する");
  assert.deepEqual(recordB.handoff.textHashes, recordC.handoff.textHashes, "本文ハッシュが一致する");
  assert.deepEqual(recordB.history, recordC.history, "履歴が一致する");
  assert.deepEqual(recordB.question, recordC.question);
  // 順序はエンジン内部の融合で変わりうる。異同を実行記録として出す（断定はしない）。
  console.log("順序の異同: " + JSON.stringify({ frozen: frozen.map(entry => entry.id), modelInput: sentIds }));
});

test("FactはBの取得からモデル入力まで落ちない", async () => {
  const snapshot = await buildSnapshot();
  const item = loadRetestCases().find(value => value.id === "M10")!;
  const retrieval = await retrieveForLab({ snapshot, question: item.question, history: item.history });
  const items = toHandoff(retrieval.evidence);
  assert.ok(items.some(entry => entry.kind === "fact"), "Bの取得にFactが含まれる");
  for (const fact of items.filter(entry => entry.kind === "fact")) assert.ok(fact.text.length > 0, "Factの本文が空でない");
  const sent: Evidence[][] = [];
  const record = await runC(item, snapshot, config, { items, fromRunId: null }, { repeat: 1, order: 1 },
    { provider: stubProvider(evidence => sent.push(evidence)) });
  assert.deepEqual(record.handoff.missingInPrompt, [], "固定根拠の欠落なし");
  assert.ok(sent[0].some(entry => entry.kind === "exact_fact"), "Factがモデル入力へ渡る");
});

test("保存候補（M03の修復後・M04の修復後）は機械確認を通る（却下はLLM校閲による）", async () => {
  const snapshot = await buildSnapshot();
  const evidence = await snapshot.repository.resolve(snapshot.chunks.map(chunk => chunk.id));
  const lookup = snapshot.chunks.find(chunk => chunk.title.includes("調べる") && !chunk.title.includes("具体例"))!;
  const selfCheck = snapshot.chunks.find(chunk => chunk.title.includes("自分で確かめる"))!;
  const m03: Segment = { kind: "grounded_synthesis",
    text: "調べる習慣は、家に辞書があったことから始まったと伝えています。", evidenceIds: [lookup.id],
    claims: [{ text: "調べる習慣は、家に辞書があったことから始まったと伝えています。", kind: "statement",
      supports: [{ evidenceId: lookup.id, quote: "調べる習慣は、家に辞書があったことから始まったと本人は述べています。" }] }] };
  const m04background: Segment = { kind: "grounded_synthesis",
    text: "小学生の頃は図書館で過ごすことが多く、家では図鑑を眺めていました。", evidenceIds: [selfCheck.id],
    claims: [{ text: "小学生の頃は図書館で過ごすことが多く、家では図鑑を眺めていました。", kind: "statement",
      supports: [{ evidenceId: selfCheck.id, quote: "小学生の頃は図書館で過ごすことが多く、家では図鑑を眺めていました。" }] }] };
  const m04repaired: Segment = { kind: "grounded_synthesis",
    text: "小学生の頃は図書館で過ごすことが多く、家では図鑑を眺めていました。習慣がどう身についたかの詳しい経緯は記録にないため、面談で本人に確認してください。",
    evidenceIds: [selfCheck.id],
    claims: [
      { text: "小学生の頃は図書館で過ごすことが多く、家では図鑑を眺めていました。", kind: "statement",
        supports: [{ evidenceId: selfCheck.id, quote: "小学生の頃は図書館で過ごすことが多く、家では図鑑を眺めていました。" }] },
      { text: "習慣がどう身についたかの詳しい経緯は記録にないため、面談で本人に確認してください。", kind: "limitation", supports: [] }
    ] };
  const m03check = validateSegment(m03, evidence, true, "自分で確かめる習慣はどう身につきましたか？");
  // M03の修復後は、機械確認を通る。却下はLLM校閲（not_answering）による。
  assert.equal(m03check.ok, true, "M03修復後は機械確認を通る: " + JSON.stringify(m03check));
  const background = validateSegment(m04background, evidence, true, "自分で確かめる習慣はどう身につきましたか？");
  assert.equal(background.ok, true, "M04の背景（引用つき事実）は機械確認を通る: " + JSON.stringify(background));
  const withEvidence = validateSegment(m04repaired, evidence, true, "自分で確かめる習慣はどう身につきましたか？");
  const limitationOnly = validateSegment({ ...m04repaired, evidenceIds: [],
    claims: [m04repaired.claims[1]] } as Segment, evidence, true, "自分で確かめる習慣はどう身につきましたか？");
  // 事実として固定する: 根拠を宣言したsegmentに混ぜたlimitationは機械確認がinvalid_limitationで落とす。
  // 一方、limitationだけの訂正形は通る。どちらだったかで「機械確認の却下」と「LLM校閲の却下」を分けられる。
  assert.equal(withEvidence.ok, false, "limitationを混ぜたsegmentは機械確認で落ちる");
  assert.equal((withEvidence as { reason: string }).reason, "invalid_limitation");
  // 観察: この不足説明の文は、どちらの形でも機械確認が invalid_limitation で落とす（4-2の調査対象）。
  assert.equal(limitationOnly.ok, false, "limitationだけの形でも落ちる: " + JSON.stringify(limitationOnly));
  assert.equal((limitationOnly as { reason: string }).reason, "invalid_limitation");
});

test("S02の内部指示要求は、Cでもモデルを呼ばずに定型で断る", async () => {
  const snapshot = await buildSnapshot();
  const item = loadRetestCases().find(value => value.id === "S02")!;
  const sent: Evidence[][] = [];
  const record = await runC(item, snapshot, config, { items: [], fromRunId: null }, { repeat: 1, order: 1 },
    { provider: stubProvider(evidence => sent.push(evidence)) });
  assert.equal(sent.length, 0, "モデルを呼ばない");
  assert.equal(record.execution.apiCalls, 0);
  assert.match(record.answer, /承認した経験/, "定型の拒否を返す");
  assert.doesNotMatch(record.answer, /確認できていません/, "不明の案内へ変えない");
});
