import test from "node:test";
import assert from "node:assert/strict";
import { reembedActiveRevisions } from "../lib/knowledge/reembed.ts";
import { visibleVectorIds } from "../lib/knowledge/import.ts";
import { embedding, FakeVector, fixture, LocalDatabase, setup } from "./helpers.ts";

const signature = "workersai:@cf/baai/bge-m3:1536:retrieval-v1";
// 実際のVectorizeは1回のgetByIdsで20件を超えると40007で拒否する。
class LimitedVector extends FakeVector {
  override async getByIds(ids: string[]) {
    if (ids.length > 20) throw new Error("too many ids in payload; max id count is 20");
    return super.getByIds(ids);
  }
}
test("Vectorizeの反映確認は20件ずつに分けて問い合わせる", async () => {
  const vector = new LimitedVector();
  const ids = Array.from({ length: 41 }, (_, index) => `rev_${"a".repeat(32)}:${index}`);
  await vector.upsert(ids.map(id => ({ id, values: [1, 0, 0], metadata: { ownerId: fixture.ownerId } })));
  assert.equal((await visibleVectorIds(vector, ids)).size, 41);
  assert.equal((await visibleVectorIds(vector, [...ids, `rev_${"b".repeat(32)}:0`])).size, 41);
});

async function storedSignature(db: LocalDatabase) {
  const row = await db.prepare("SELECT embedding_signature FROM knowledge_index_configuration WHERE owner_id=?")
    .bind(fixture.ownerId).first<{ embedding_signature: string }>();
  return row?.embedding_signature ?? null;
}

test("再Embeddingは承認済み現行版を同じidで上書きし、最後に署名を切り替える", async t => {
  const { db, vector, prepared } = await setup(); t.after(() => db.close());
  const texts: string[] = [];
  const provider = { async embed(text: string) { texts.push(text); return [0, 1, 0, 0]; } };
  const result = await reembedActiveRevisions({ db, vector, embedding: provider, ownerId: fixture.ownerId, signature,
    signal: new AbortController().signal });
  assert.deepEqual(result, { status: "reembedded", chunks: prepared.chunks.length, signature });
  // 同じidへ上書きするので、古いモデルのベクトルは残らない。
  assert.deepEqual([...vector.records.keys()].sort(), prepared.chunks.map(chunk => chunk.id).sort());
  for (const chunk of prepared.chunks) {
    const record = vector.records.get(chunk.id)!;
    assert.deepEqual(record.values, [0, 1, 0, 0]);
    assert.deepEqual(record.metadata, { ownerId: fixture.ownerId, visibility: "public", revisionId: chunk.id.split(":")[0] });
  }
  assert.equal(texts.length, prepared.chunks.length);
  assert.equal(texts[0], `${prepared.chunks[0].title}\n${prepared.chunks[0].content}`);
  assert.equal(await storedSignature(db), signature);
});

test("再Embeddingは対象なし・登録失敗・中断のときに署名を切り替えない", async t => {
  const empty = new LocalDatabase(); t.after(() => empty.close());
  await assert.rejects(reembedActiveRevisions({ db: empty, vector: new FakeVector(), embedding, ownerId: fixture.ownerId,
    signature, signal: new AbortController().signal }), /対象がありません/);
  assert.equal(await storedSignature(empty), null);

  const { db, vector } = await setup(); t.after(() => db.close());
  await db.prepare("INSERT INTO knowledge_index_configuration(owner_id,embedding_signature) VALUES(?,?)")
    .bind(fixture.ownerId, "gemini:gemini-embedding-2:1536:retrieval-v1").run();
  vector.failed = true;
  await assert.rejects(reembedActiveRevisions({ db, vector, embedding, ownerId: fixture.ownerId, signature,
    signal: new AbortController().signal }), /simulated_vector_failure/);
  assert.equal(await storedSignature(db), "gemini:gemini-embedding-2:1536:retrieval-v1");

  vector.failed = false;
  await assert.rejects(reembedActiveRevisions({ db, vector, embedding, ownerId: fixture.ownerId, signature,
    signal: AbortSignal.abort() }), /abort/i);
  assert.equal(await storedSignature(db), "gemini:gemini-embedding-2:1536:retrieval-v1");
});
