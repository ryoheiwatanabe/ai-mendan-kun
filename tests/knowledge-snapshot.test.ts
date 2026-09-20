// 根拠の再照合（revalidateSnapshot）を、実際のLocalDatabaseと取込経路で確認する。
// モックのリポジトリでは「11件以上を1回のSQLで照合できるか」「D1のbind上限に収まるか」を確かめられない。
// 対象は照合の合否と、bindの数が根拠の件数に比例しないこと。モデルの正確さは対象外。
import test from "node:test";
import assert from "node:assert/strict";
import { KnowledgeRepository } from "../lib/knowledge/repository.ts";
import { approveImport, prepareImport, revokeRevision } from "../lib/knowledge/import.ts";
import { FakeVector, LocalDatabase, embedding } from "./helpers.ts";
import type { Database, Evidence, Fact, Statement } from "../lib/types.ts";

const owner = "snapshot-owner";

// 照合のSQLを記録し、bindの数が根拠の件数に比例しないことを確かめる。
class RecordingDatabase implements Database {
  readonly statements: string[] = [];
  private readonly inner: Database;
  constructor(inner: Database) { this.inner = inner; }
  prepare(sql: string): Statement { this.statements.push(sql); return this.inner.prepare(sql); }
  batch<T = Record<string, unknown>>(statements: Statement[]): Promise<{ results: T[] }[]> { return this.inner.batch<T>(statements); }
  clear() { this.statements.length = 0; }
  // 直近の1文に含まれるbindの数。
  placeholders(): number { return (this.statements.at(-1)?.match(/\?/g) ?? []).length; }
}

// 1つの見出しに1つの段落を置く。Factの承認文は、本文中の段落とそのまま一致させる。
function documentFixture(documentId: string, headings: number, factCount = 0) {
  const paragraphs = Array.from({ length: headings }, (_, index) =>
    "確認用の段落" + (index + 1) + "です。" + documentId + "の公開内容をここに置きます。");
  const content = paragraphs.map((paragraph, index) => "# 見出し" + (index + 1) + "\n\n" + paragraph).join("\n\n");
  const facts = Array.from({ length: factCount }, (_, index) => ({ id: "f" + (index + 1), key: "k" + (index + 1),
    value: "値" + (index + 1), statement: paragraphs[index], aliases: ["確認", documentId],
    validFrom: "2020-01-01", validTo: null }));
  return { version: 1, ownerId: owner, documentId, title: "確認用の資料" + documentId, visibility: "public",
    verification: "self_reported", entities: ["確認用"], content, facts };
}

async function importDocument(db: Database, vector: FakeVector, documentId: string, headings: number, factCount = 0) {
  const prepared = await prepareImport(documentFixture(documentId, headings, factCount));
  await approveImport({ db, vector, embedding, prepared, approvalHash: prepared.hash,
    signal: new AbortController().signal, waitForVectors: async () => {} });
  return prepared;
}

// 本番と同じ少ない件数で取り出し、見出しと本文を現行のDBから組み立てる。
async function collect(repository: KnowledgeRepository, db: Database): Promise<Evidence[]> {
  const sql = "SELECT c.id FROM knowledge_chunks c "
    + "JOIN knowledge_document_revisions r ON r.id=c.revision_id "
    + "JOIN knowledge_documents d ON d.id=r.document_id "
    + "WHERE d.active_revision_id=r.id AND r.approval_status='approved' AND r.visibility='public' AND r.index_state='indexed' "
    + "ORDER BY c.revision_id COLLATE BINARY, c.chunk_index";
  const ids = (await db.prepare(sql).all<{ id: string }>()).results.map(row => row.id);
  const chunks: Evidence[] = [];
  for (let index = 0; index < ids.length; index += 10) chunks.push(...await repository.resolve(ids.slice(index, index + 10)));
  const facts = (await repository.facts()).map((row: Fact) => ({ id: "fact:" + row.id, revisionId: row.revision_id,
    documentId: row.document_id, contentHash: row.content_hash, title: row.fact_key, content: row.statement,
    kind: "exact_fact" as const, entities: [], rank: 0 }));
  return [...chunks, ...facts];
}

test("11件以上の根拠も1回の照合で通り、bindの数は件数に比例しない", async t => {
  const db = new LocalDatabase(); t.after(() => db.close());
  const vector = new FakeVector();
  const recording = new RecordingDatabase(db);
  const repository = new KnowledgeRepository(recording, owner);
  await importDocument(db, vector, "doc1", 6, 1);
  await importDocument(db, vector, "doc2", 6, 1);
  const all = await collect(repository, db);
  assert.ok(all.length >= 12, "12件以上を用意する（実際" + all.length + "件）");
  const union = all.slice(0, 12);

  recording.clear();
  assert.equal(await repository.revalidateSnapshot(union), true, "11件以上の結合も1回の照合で通す");
  const placeholders = recording.placeholders();
  assert.ok(placeholders <= 4, "bindは4個以下に収める（実際" + placeholders + "個）");

  recording.clear();
  assert.equal(await repository.revalidateSnapshot(union.slice(0, 11)), true);
  assert.equal(recording.placeholders(), placeholders, "件数を増やしてもbindの数は変わらない");
});

test("通常の上限22件までは通り、32件を超える集合は照合せずに拒否する", async t => {
  const db = new LocalDatabase(); t.after(() => db.close());
  const vector = new FakeVector();
  const repository = new KnowledgeRepository(db, owner);
  for (const documentId of ["doc1", "doc2", "doc3", "doc4"]) await importDocument(db, vector, documentId, 6, 3);
  const all = await collect(repository, db);
  assert.ok(all.length >= 33, "33件以上を用意する（実際" + all.length + "件）");
  assert.equal(await repository.revalidateSnapshot(all.slice(0, 10)), true, "初回検索の10件");
  assert.equal(await repository.revalidateSnapshot(all.slice(0, 22)), true, "10件に探索の追加を足した22件");
  assert.equal(await repository.revalidateSnapshot(all.slice(0, 32)), true, "防御上限の32件");
  assert.equal(await repository.revalidateSnapshot(all.slice(0, 33)), false, "33件は照合せずに拒否する");
});

test("結合のうち1件でも改変・所有者違い・撤回があれば、まとめて拒否する", async t => {
  const db = new LocalDatabase(); t.after(() => db.close());
  const vector = new FakeVector();
  const repository = new KnowledgeRepository(db, owner);
  await importDocument(db, vector, "doc1", 6, 1);
  const second = await importDocument(db, vector, "doc2", 6, 1);
  const union = (await collect(repository, db)).slice(0, 12);
  assert.equal(union.length, 12);
  assert.equal(await repository.revalidateSnapshot(union), true, "12件の結合は通る");

  const [head, ...rest] = union;
  assert.equal(await repository.revalidateSnapshot([...rest, { ...head, content: head.content + "追記" }]), false, "本文が改変されたら拒否");
  assert.equal(await repository.revalidateSnapshot([...rest, { ...head, contentHash: "invalid-test-hash" }]), false, "承認ハッシュが違えば拒否");
  assert.equal(await repository.revalidateSnapshot([...rest, { ...head, title: "別の見出し" }]), false, "見出しが違えば拒否");
  assert.equal(await new KnowledgeRepository(db, "other-owner").revalidateSnapshot(union), false, "所有者が違えば拒否");

  await revokeRevision(db, vector, owner, second.revisionId);
  assert.equal(await repository.revalidateSnapshot(union), false, "結合の一部が撤回されたら拒否する");
  assert.equal(await repository.revalidateSnapshot(union.filter(item => item.revisionId !== second.revisionId)), true,
    "撤回していない版だけなら通る");
});

test("空の集合と重複IDは照合せずに拒否する", async t => {
  const db = new LocalDatabase(); t.after(() => db.close());
  const vector = new FakeVector();
  const repository = new KnowledgeRepository(db, owner);
  await importDocument(db, vector, "doc1", 6, 1);
  await importDocument(db, vector, "doc2", 6, 1);
  const union = (await collect(repository, db)).slice(0, 12);
  assert.equal(await repository.revalidateSnapshot([]), false, "空の集合は拒否");
  assert.equal(await repository.revalidateSnapshot([union[0], ...union]), false, "同じIDを2度渡したら拒否");
});

test("引用していない資料を足したときも、同じ1回の照合で資料集合の変化を検出する", async t => {
  const db = new LocalDatabase(); t.after(() => db.close());
  const vector = new FakeVector();
  const recording = new RecordingDatabase(db);
  const repository = new KnowledgeRepository(recording, owner);
  await importDocument(db, vector, "doc1", 6, 1);
  await importDocument(db, vector, "doc2", 6, 1);
  const union = (await collect(repository, db)).slice(0, 12);
  const sourceSet = await repository.sourceSet();

  recording.clear();
  assert.equal(await repository.revalidateSnapshot(union, sourceSet), true, "引用した版と資料集合が一致すれば通る");
  const placeholders = recording.placeholders();
  assert.ok(placeholders <= 4, "資料集合を足してもbindは4個以下（実際" + placeholders + "個）");

  await importDocument(db, vector, "doc3", 2, 0);
  assert.equal(await repository.revalidateSnapshot(union, sourceSet), false, "引用していない資料の追加を検出する");
  assert.equal(await repository.revalidateSnapshot(union, await repository.sourceSet()), true, "集合を取り直せば通る");
});

test("件数を絞る前のrevalidateも、11件以上の結合と改変を見分ける", async t => {
  const db = new LocalDatabase(); t.after(() => db.close());
  const vector = new FakeVector();
  const repository = new KnowledgeRepository(db, owner);
  await importDocument(db, vector, "doc1", 6, 1);
  await importDocument(db, vector, "doc2", 6, 1);
  const union = (await collect(repository, db)).slice(0, 12);
  assert.equal(await repository.revalidate(union), true, "11件以上でも通る");
  const [head, ...rest] = union;
  assert.equal(await repository.revalidate([...rest, { ...head, content: head.content + "追記" }]), false);
});
