// 再試験の土台（同一スナップショット・根拠の門・実行順）を、通信せずに確かめる。
import test from "node:test";
import assert from "node:assert/strict";
import { FrozenRepository, buildSnapshot, hideMemo, resolveRefs, retrieveForLab } from "../src/snapshot.mts";
import { buildRunPlan, loadRetestCases } from "../src/retest.mts";

const cases = loadRetestCases();

test("ケースは指示書の必須項目を持つ", () => {
  for (const item of cases) {
    for (const key of ["question", "history", "expected", "evidenceKind", "evidenceRefs", "requiredClaims", "allowedLimitations", "forbiddenClaims"]) {
      assert.ok(key in item, item.id + " に " + key + " がない");
    }
    assert.ok(["answerable", "partial", "insufficient", "ambiguous", "refused"].includes(item.expected), item.id);
  }
  assert.equal(cases.filter(item => item.kind === "main").length, 10);
});

test("根拠参照は、見出しの表記揺れを越えて現在のチャンクへ解決する", async () => {
  const snapshot = await buildSnapshot();
  const m01 = cases.find(item => item.id === "M01")!;
  const resolved = resolveRefs(snapshot, m01.evidenceRefs);
  assert.equal(resolved.length, 2, "M01の2件が解決する");
  const m03 = cases.find(item => item.id === "M03")!;
  const lookup = resolveRefs(snapshot, m03.evidenceRefs);
  assert.equal(lookup.length, 1, "全角括弧の見出しも半角の記録へ解決する");
  assert.equal(lookup[0].id, snapshot.chunks.find(chunk => chunk.title.includes("調べる"))!.id);
});

test("非公開にした社内メモは、検索でも再確認でも使えない", async () => {
  const snapshot = await buildSnapshot();
  const memo = snapshot.chunks.find(chunk => chunk.title.includes("価格改定"))!;
  await hideMemo(snapshot);
  const after = await buildSnapshot();
  await hideMemo(after);
  assert.equal(await after.repository.resolve([memo.id]).then(items => items.length), 0, "非公開の版は解決できない");
  const s01 = cases.find(item => item.id === "S01")!;
  const retrieval = await retrieveForLab({ snapshot: after, question: s01.question, history: [] });
  for (const evidence of retrieval.evidence) {
    assert.equal(evidence.content.includes("12パーセント"), false, "非公開の値を根拠へ出さない");
  }
});

test("固定根拠のアダプターは、外の根拠を混ぜずに同じ集合を返す", async () => {
  const snapshot = await buildSnapshot();
  const first = snapshot.chunks.find(chunk => chunk.title.includes("独立後"))!;
  const evidence = await snapshot.repository.resolve([first.id]);
  const repository = new FrozenRepository("fictional-minato", evidence);
  const keyword = await repository.keyword("別の話題");
  assert.deepEqual(keyword.map(item => item.id), evidence.map(item => item.id), "検索語に関わらず固定集合を返す");
  assert.equal((await repository.facts()).length, 0);
  assert.deepEqual((await repository.resolve([first.id])).map(item => item.id), [first.id]);
  assert.equal(await repository.revalidate(evidence), true);
});

test("実行順はケースごとに条件を交互に並べ、反復できる", () => {
  const picked = cases.filter(item => item.kind === "main").slice(0, 2);
  const plan = buildRunPlan(picked, ["A", "B", "C"], 2, "interleave");
  assert.equal(plan.length, 2 * 3 * 2);
  assert.deepEqual(plan.slice(0, 6).map(step => step.caseId + step.condition),
    [picked[0].id + "A", picked[0].id + "B", picked[0].id + "C", picked[1].id + "A", picked[1].id + "B", picked[1].id + "C"]);
  assert.deepEqual([...new Set(plan.map(step => step.repeat))].sort(), [1, 2]);
});
