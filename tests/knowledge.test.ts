import test from "node:test";
import assert from "node:assert/strict";
import { KnowledgeRepository } from "../lib/knowledge/repository.ts";
import { approveImport, prepareImport, revokeRevision, stageImport } from "../lib/knowledge/import.ts";
import { expandQuery, fuse, selectFacts, retrieve } from "../lib/knowledge/retrieval.ts";
import type { Evidence } from "../lib/types.ts";
import { chunkMarkdown, searchQuery, searchTerms } from "../lib/knowledge/text.ts";
import { embedding, FakeVector, fixture, LocalDatabase, setup } from "./helpers.ts";

// 融合の検証用。実際の検索結果の形（キーワード16件・ベクトル16件）を模す。
const ranked = (ids: string[]): Evidence[] => ids.map((id, rank) => ({ id, revisionId: `rev_${id}`, documentId: `doc_${id}`,
  title: id, content: id, contentHash: id, entities: [], kind: "chunk", rank }));

test("融合は片方の検索の上位候補を、融合順位が下でも落とさない", () => {
  // 実際にあった形: 「大学時代」の段落はキーワード5件目・ベクトル14件目で、融合9件目。
  // 上位8件で切ると落ちていた。
  const keyword = ranked(["b5", "b1", "f3", "b2", "b3", "b0", "c1", "c0", "c3", "c2", "e6", "f2", "f4", "b4", "g2", "f1"]);
  const vector = ranked(["x0", "c0", "g2", "f0", "f2", "f3", "f5", "f6", "g4", "g5", "b0", "b1", "b2", "b3", "b4", "b5"]);
  const fused = fuse(keyword, vector, []);
  const ids = fused.map(item => item.id);
  assert.ok(ids.includes("b3"), "片方の検索で上位の候補を融合で落とさない");
  assert.ok(ids.includes("x0"), "ベクトル1位の候補を、融合順位が下でも残す");
  for (const id of ["b5", "b1", "f3", "c0", "g2"]) assert.ok(ids.includes(id), `${id}を残す`);
  assert.equal(ids.length, 10, "回答モデルへ渡す候補の上限を保つ");
});

test("融合は事実（exact_fact）を候補へ必ず残す", () => {
  const keyword = ranked(["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8", "k9", "k10", "k11", "k12"]);
  const vector = ranked(["v0", "k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8", "k9", "k10", "k11"]);
  const fact: Evidence = { ...ranked(["fact:a"])[0], kind: "exact_fact" };
  const fused = fuse(keyword, vector, [fact]);
  assert.ok(fused.some(item => item.id === "fact:a"), "事実は融合で落とさない");
  assert.ok(fused.some(item => item.id === "v0"), "ベクトル1位の候補も残す");
  assert.equal(fused.length, 10);
});

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

test("回答に使う見出しと本文を送信前に再照合する", async t => {
  const { db, prepared } = await setup(); t.after(() => db.close());
  const repository = new KnowledgeRepository(db, fixture.ownerId);
  const [source] = await repository.resolve([prepared.chunks[0].id]);
  for (const revalidate of [repository.revalidate.bind(repository), repository.revalidateSnapshot.bind(repository)]) {
    assert.equal(await revalidate([source]), true);
    assert.equal(await revalidate([{ ...source, title: "別の団体名" }]), false);
    assert.equal(await revalidate([{ ...source, content: source.content + "未承認の追記。" }]), false);
  }
  await db.prepare("UPDATE knowledge_chunks SET title=? WHERE id=?").bind("変更後の見出し", source.id).run();
  assert.equal(await repository.revalidate([source]), false);
  assert.equal(await repository.revalidateSnapshot([source]), false);
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
  const comparison = selectFacts(facts, "2022年と2026年のチーム人数");
  assert.deepEqual(comparison.conflicts, []);
  assert.equal(comparison.selected.some(item => item.statement.includes("5人")), true);
  assert.equal(comparison.selected.some(item => item.statement.includes("8人")), true);
});

test("引用用段落を途中で分割せず、但し書きも同じChunkに維持", () => {
  const paragraph = "チームで成果を出しました。\nただし、私は実装していません。";
  assert.ok(chunkMarkdown(`# 経歴\n\n${paragraph}`)[0].content.includes(paragraph));
  assert.throws(() => chunkMarkdown("あ".repeat(801)), /800文字/);
});

test("自己紹介は経験を検索し、追質問は直前の回答も手掛かりにする", () => {
  assert.match(searchQuery("簡単な自己紹介お願いします", []), /経歴.*担当/);
  const history = [{ role: "user", content: "何をしてきましたか？" },
    { role: "assistant", content: "ゲームコミュニティの運営を担当しました。" }];
  assert.match(searchQuery("具体的な名前は？", history), /ゲームコミュニティ/);
  assert.match(searchQuery("何と呼ばれていますか？", history), /ゲームコミュニティ/);
  assert.equal(searchQuery("資格はありますか？", history), "資格はありますか？");
  assert.ok(searchQuery("それを詳しく", [{ role: "assistant", content: "あ".repeat(6000) }]).length <= 4000);
});

test("年を指定しない追質問をassistant履歴の古い年だけに限定しない", async t => {
  const { db, vector } = await setup(); t.after(() => db.close());
  const result = await retrieve({ question: "もう少し詳しく", history: [
    { role: "user", content: "チーム人数を教えて" },
    { role: "assistant", content: "2022年の検証チームは5人でした。" }],
    repository: new KnowledgeRepository(db, fixture.ownerId), vector, embedding, signal: new AbortController().signal });
  assert.ok(result.evidence.some(item => item.kind === "exact_fact" && item.content.includes("8人")));
  assert.equal(result.evidence.some(item => item.content.includes("5人")), true);
});

test("名前だけの追質問でも直前の話題から承認済み見出しを再検索する", async t => {
  const { db, vector } = await setup({ ...fixture, facts: [], entities: [],
    content: "# Bluebird Guild\n\nゲームコミュニティを共同創業し、イベントの企画を担当しました。" });
  t.after(() => db.close());
  t.mock.method(vector, "query", async () => ({ matches: [] }));
  const repository = new KnowledgeRepository(db, fixture.ownerId);
  const input = { question: "具体的な名前は？", history: [
    { role: "user" as const, content: "自己紹介をお願いします" },
    { role: "assistant" as const, content: "ゲームコミュニティを共同創業しました。" }],
    repository, vector, embedding, signal: new AbortController().signal };
  const result = await retrieve(input);
  assert.equal(result.evidence[0]?.title, "Bluebird Guild");
  await db.prepare("UPDATE knowledge_document_revisions SET approval_status='revoked'").run();
  assert.equal((await retrieve(input)).evidence.length, 0, "履歴に残る記述を根拠として復活させない");
});

test("以前の話題の年号を遠い履歴から再度持ち込まない", async t => {
  const { db, vector } = await setup(); t.after(() => db.close());
  const history = [
    { role: "user" as const, content: "2022年のチーム人数は？" }, { role: "assistant" as const, content: "5人でした。" },
    { role: "user" as const, content: "仕事の進め方は？" }, { role: "assistant" as const, content: "小さく試します。" },
    { role: "user" as const, content: "2026年のチーム人数は？" }, { role: "assistant" as const, content: "8人です。" }
  ];
  const result = await retrieve({ question: "その人数をもう少し詳しく", history,
    repository: new KnowledgeRepository(db, fixture.ownerId), vector, embedding, signal: new AbortController().signal });
  assert.deepEqual(result.conflicts, []);
  assert.ok(result.evidence.some(item => item.kind === "exact_fact" && item.content.includes("8人")));
  assert.equal(result.query.includes("2022"), false);
});

test("不正な公開範囲、Fact引用、省略、循環訂正を取り込まない", async () => {
  await assert.rejects(prepareImport({ ...fixture, visibility: "private" }), /public/);
  await assert.rejects(prepareImport({ ...fixture, facts: [{ ...fixture.facts[0], statement: "チームは5人でした。" }] }), /完全一致/);
  await assert.rejects(prepareImport({ ...fixture, facts: [{ ...fixture.facts[0], supersedesFactId: "old-count" }] }), /訂正関係/);
});

test("言い換え検索の展開語は、記録側の言い方へ届く語を含む", () => {
  const web3 = expandQuery("Web3の経験はありますか");
  for (const word of ["ブロックチェーン", "暗号資産", "Defi", "トークン"]) assert.ok(web3.includes(word), word);
  const company = expandQuery("会社員経験について教えてください");
  for (const word of ["勤務", "入社", "退社", "仕事"]) assert.ok(company.includes(word), word);
  const reason = expandQuery("志望動機を教えてください");
  for (const word of ["応募", "惹かれ", "転職"]) assert.ok(reason.includes(word), word);
  // 記録側はSV・シフト管理・KPI運用・スタッフ育成と書かれている。
  const management = expandQuery("マネジメント経験はありますか");
  for (const word of ["スーパーバイザー", "シフト管理", "KPI", "育成", "部下"]) assert.ok(management.includes(word), word);
  const start = expandQuery("いつから働けますか");
  for (const word of ["稼働", "週3", "時間帯"]) assert.ok(start.includes(word), word);
  const billing = expandQuery("課金方式を変えた理由と結果を教えてください");
  for (const word of ["買い切り", "商品構成", "転換"]) assert.ok(billing.includes(word), word);
});

// 音声認識は語の切れ目にも空白を入れる（「会 社 員 経 験」）。空白の有無で検索の手掛かりが変わらないようにする。
test("語中に空白が入っても、検索語・概要の判定・展開語・Fact照合が同じように効く", async t => {
  const { db } = await setup(); t.after(() => db.close());
  // 漢字・かなの間の空白は詰めてbigramを作る。英単語の区切りは残す。
  const terms = searchTerms("会 社 員 の 経 験 と AI 支援");
  for (const term of ["会社", "社員", "員の", "の経", "経験", "験と", "支援"]) assert.ok(terms.includes(term), term);
  assert.ok(terms.includes("ai"), "英単語はそのまま1語として扱う");
  // 名前を尋ねる質問は履歴を継ぎ足さず、概要の依頼は見出しへ届かせる語を足す。
  assert.match(searchQuery("簡 単 な 自 己 紹 介 を お 願 い し ます", []), /経歴.*担当/);
  for (const word of ["勤務", "入社", "退社"]) assert.ok(expandQuery("会 社 員 経 験 に つ い て 教 え て ください").includes(word), word);
  // 別名でのFact照合も空白に左右されない。
  const facts = await new KnowledgeRepository(db, fixture.ownerId).facts();
  assert.equal(selectFacts(facts, "現 在 の チ ー ム 人 数", "2026-09-10").selected[0].fact_value, "8");
});
