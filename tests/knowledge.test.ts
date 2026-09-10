import test from "node:test";
import assert from "node:assert/strict";
import { KnowledgeRepository } from "../lib/knowledge/repository.ts";
import { approveImport, prepareImport, revokeRevision, stageImport } from "../lib/knowledge/import.ts";
import { selectFacts, retrieve } from "../lib/knowledge/retrieval.ts";
import { chunkMarkdown } from "../lib/knowledge/text.ts";
import { embedding, FakeVector, fixture, LocalDatabase, setup } from "./helpers.ts";

test("日本語FTSとVector ID解決は承認済み現行版だけを返す", async t => {
  const { db, vector } = await setup(); t.after(() => db.close());
  const repository = new KnowledgeRepository(db, fixture.ownerId);
  assert.ok((await repository.keyword("要件整理の経験")).some(item => item.content.includes("要件整理")));
  const result = await retrieve({ question: "仕事で大切にしていること", history: [], repository, vector, embedding, signal: new AbortController().signal });
  assert.ok(result.evidence.length);
  assert.ok(await repository.revalidate(result.evidence));
  assert.equal((await new KnowledgeRepository(db, "someone-else").keyword("要件整理")).length, 0);
});

for (const condition of ["draft", "superseded", "revoked", "rejected", "private", "interview", "inactive", "wrong-owner", "index-failed"]) {
  test(`古いVectorが残っていても ${condition} は検索と再検証で除外`, async t => {
    const { db, vector, prepared } = await setup(); t.after(() => db.close());
    const repository = new KnowledgeRepository(db, fixture.ownerId);
    const previous = await repository.resolve(prepared.chunks.map(item => item.id));
    assert.ok(previous.length);
    if (["private", "interview"].includes(condition)) await db.prepare("UPDATE knowledge_document_revisions SET visibility=?").bind(condition).run();
    else if (condition === "inactive") await db.prepare("UPDATE knowledge_documents SET active_revision_id=NULL").run();
    else if (condition === "wrong-owner") await db.prepare("UPDATE knowledge_document_revisions SET owner_id='other-owner'").run();
    else if (condition === "index-failed") await db.prepare("UPDATE knowledge_document_revisions SET index_state='failed'").run();
    else await db.prepare("UPDATE knowledge_document_revisions SET approval_status=?").bind(condition).run();
    assert.equal((await repository.resolve([...vector.records.keys()])).length, 0);
    assert.equal((await repository.keyword("要件整理")).length, 0);
    assert.equal((await repository.facts()).length, 0);
    assert.equal(await repository.revalidate(previous), false);
  });
}

test("draft保存は検索・Embedding・Vector登録をしない", async t => {
  const db = new LocalDatabase(); t.after(() => db.close());
  const prepared = await prepareImport(fixture);
  assert.equal((await stageImport(db, prepared)).status, "draft");
  assert.equal(await new KnowledgeRepository(db, fixture.ownerId).hasKnowledge(), false);
  assert.equal((await db.prepare("SELECT * FROM knowledge_chunks").all()).results.length, 0);
});

test("承認ハッシュは本文以外のExact Facts・検索語変更も検知", async t => {
  const db = new LocalDatabase(); t.after(() => db.close());
  const prepared = await prepareImport(fixture);
  const changed = await prepareImport({ ...fixture, entities: [...fixture.entities, "新しい検索語"] });
  assert.notEqual(prepared.hash, changed.hash);
  await assert.rejects(approveImport({ db, vector: new FakeVector(), embedding, prepared: changed, approvalHash: prepared.hash, signal: new AbortController().signal }), /ハッシュ/);
  assert.equal((await db.prepare("SELECT * FROM knowledge_documents").all()).results.length, 0);
});

test("新版のVector登録が失敗しても旧承認版を維持、再実行で一度だけ切替", async t => {
  const { db, vector, prepared } = await setup(); t.after(() => db.close());
  const next = await prepareImport({ ...fixture, content: fixture.content + "\n\n追記した公開用の説明です。" });
  vector.failed = true;
  await assert.rejects(approveImport({ db, vector, embedding, prepared: next, approvalHash: next.hash, signal: new AbortController().signal }));
  const repository = new KnowledgeRepository(db, fixture.ownerId);
  assert.equal((await repository.resolve(prepared.chunks.map(item => item.id))).length, prepared.chunks.length);
  assert.equal((await repository.resolve(next.chunks.map(item => item.id))).length, 0);
  vector.failed = false;
  assert.equal((await approveImport({ db, vector, embedding, prepared: next, approvalHash: next.hash, signal: new AbortController().signal })).status, "active");
  assert.equal((await approveImport({ db, vector, embedding, prepared: next, approvalHash: next.hash, signal: new AbortController().signal })).status, "already_active");
  assert.equal((await repository.resolve(prepared.chunks.map(item => item.id))).length, 0);
  assert.ok((await repository.resolve(next.chunks.map(item => item.id))).length);
});

test("撤回はVector削除が失敗しても即時有効で、同一版は再承認不可", async t => {
  const { db, vector, prepared } = await setup(); t.after(() => db.close());
  vector.failed = true;
  assert.equal((await revokeRevision(db, vector, fixture.ownerId, prepared.revisionId)).vectorCleanupPending, true);
  assert.equal(await new KnowledgeRepository(db, fixture.ownerId).hasKnowledge(), false);
  await assert.rejects(approveImport({ db, vector, embedding, prepared, approvalHash: prepared.hash, signal: new AbortController().signal }), /使用できません/);
});

test("Embedding処理中の撤回を後続の承認batchが上書きしない", async t => {
  const { db, vector } = await setup(); t.after(() => db.close());
  const next = await prepareImport({ ...fixture, content: fixture.content + "\n\n処理中の撤回検証。" });
  let revoked = false;
  const concurrent = { async embed() {
    if (!revoked) { revoked = true; await revokeRevision(db, vector, fixture.ownerId, next.revisionId); }
    return [1, 0, 0];
  } };
  await assert.rejects(approveImport({ db, vector, embedding: concurrent, prepared: next, approvalHash: next.hash, signal: new AbortController().signal }), /CHECK/);
  const status = await db.prepare("SELECT approval_status FROM knowledge_document_revisions WHERE id=?").bind(next.revisionId).first<{ approval_status: string }>();
  assert.equal(status?.approval_status, "revoked");
  assert.equal(await new KnowledgeRepository(db, fixture.ownerId).hasKnowledge(), true);
});

test("並行する別Revisionの承認は先に切り替わった版を巻き戻さない", async t => {
  const { db, vector } = await setup(); t.after(() => db.close());
  const a = await prepareImport({ ...fixture, content: fixture.content + "\n\n追記A。" });
  const b = await prepareImport({ ...fixture, content: fixture.content + "\n\n追記B。" });
  await stageImport(db, a); await stageImport(db, b);
  await approveImport({ db, vector, embedding, prepared: a, approvalHash: a.hash, signal: new AbortController().signal });
  await assert.rejects(approveImport({ db, vector, embedding, prepared: b, approvalHash: b.hash, signal: new AbortController().signal }), /現行版/);
  assert.ok((await new KnowledgeRepository(db, fixture.ownerId).resolve(a.chunks.map(item => item.id))).length);
});

test("Exact Factsは2022年と現在を分け、確認日の新しさで矛盾を解消しない", async t => {
  const { db } = await setup(); t.after(() => db.close());
  const facts = await new KnowledgeRepository(db, fixture.ownerId).facts();
  assert.equal(selectFacts(facts, "2022年のチーム人数", "2026-09-10").selected[0].fact_value, "5");
  assert.equal(selectFacts(facts, "現在のチーム人数", "2026-09-10").selected[0].fact_value, "8");
  const current = facts.find(fact => fact.fact_value === "8")!;
  const conflict = { ...current, id: "conflict", fact_value: "12", statement: "別の値です。" };
  assert.deepEqual(selectFacts([...facts, conflict], "現在のチーム人数", "2026-09-10").conflicts, ["team.size"]);
  assert.equal(selectFacts([...facts, { ...conflict, supersedes_fact_id: current.id }], "現在のチーム人数", "2026-09-10").selected[0].fact_value, "12");
});

test("現在の質問に過去Factの本文Chunkを混ぜず、続きの時点変更も反映", async t => {
  const { db, vector } = await setup(); t.after(() => db.close());
  const result = await retrieve({ question: "現在は？", history: [{ role: "user", content: "2022年のチーム人数は？" }, { role: "assistant", content: "2022年の検証チームは5人でした。" }],
    repository: new KnowledgeRepository(db, fixture.ownerId), vector, embedding, signal: new AbortController().signal });
  assert.ok(result.evidence.some(item => item.kind === "exact_fact" && item.content.includes("8人")));
  assert.equal(result.evidence.some(item => item.content.includes("5人")), false);
  const facts = await new KnowledgeRepository(db, fixture.ownerId).facts();
  assert.deepEqual(selectFacts(facts, "当時のチーム人数").conflicts, ["target_time"]);
  assert.deepEqual(selectFacts(facts, "2022年と2026年のチーム人数").conflicts, ["target_time"]);
});

test("引用用段落を途中で分割せず、但し書きも同じChunkに維持", () => {
  const paragraph = "チームで成果を出しました。\nただし、私は実装していません。";
  assert.ok(chunkMarkdown(`# 経歴\n\n${paragraph}`)[0].content.includes(paragraph));
  assert.throws(() => chunkMarkdown("あ".repeat(801)), /800文字/);
});

test("不正な公開範囲、Fact引用、省略、循環訂正を取り込まない", async () => {
  await assert.rejects(prepareImport({ ...fixture, visibility: "private" }), /public/);
  await assert.rejects(prepareImport({ ...fixture, facts: [{ ...fixture.facts[0], statement: "チームは5人でした。" }] }), /完全一致/);
  await assert.rejects(prepareImport({ ...fixture, facts: [{ ...fixture.facts[0], supersedesFactId: "old-count" }] }), /訂正関係/);
});
