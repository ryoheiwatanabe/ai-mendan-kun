import test from "node:test";
import assert from "node:assert/strict";
import { SpeechChunks } from "../lib/voice/audio.ts";
import { KnowledgeRepository } from "../lib/knowledge/repository.ts";
import type { Evidence } from "../lib/types.ts";
import type { SpeechAudio } from "../lib/voice/types.ts";
import { fixture, setup } from "./helpers.ts";

const audio = (bytes: Uint8Array): SpeechAudio => ({ data: Buffer.from(bytes).toString("base64"), mimeType: "audio/pcm", sampleRate: 24_000, channels: 1 });
const signal = () => new AbortController().signal;

test("音声deltaの境界をまたいでもPCMのbyte順序・sample・最初の250ms・末尾を保つ", async () => {
  const expected = Buffer.alloc(230_014);
  for (let index = 0; index < expected.length; index++) expected[index] = index % 251;
  async function* frames() {
    for (let offset = 0; offset < expected.length; offset += 14) yield audio(expected.subarray(offset, offset + 14));
  }
  const events = await Array.fromAsync(new SpeechChunks().read(frames(), signal()));
  assert.deepEqual(events.map(event => Buffer.from(event.data, "base64").length), [12_000, 96_000, 96_000, 26_014]);
  assert.deepEqual(Buffer.concat(events.map(event => Buffer.from(event.data, "base64"))), expected);
  assert.ok(events.every(event => event.data.length <= 128_000));
});

test("250msの先頭は回答全体で一度だけにし、別TTSの末尾は次の文章へ混ぜない", async () => {
  const chunks = new SpeechChunks();
  async function* frames() { yield audio(Buffer.alloc(48_000)); }
  const first = await Array.fromAsync(chunks.read(frames(), signal()));
  const second = await Array.fromAsync(chunks.read(frames(), signal()));
  assert.deepEqual(first.map(event => Buffer.from(event.data, "base64").length), [12_000, 36_000]);
  assert.deepEqual(second.map(event => Buffer.from(event.data, "base64").length), [48_000]);
});

test("回答全体の120秒を超えるPCMは配信せず、Providerを閉じる", async () => {
  const chunks = new SpeechChunks(); let closed = false, delivered = 0;
  async function* frames() {
    try { for (let second = 0; second < 121; second++) yield audio(Buffer.alloc(48_000)); }
    finally { closed = true; }
  }
  await assert.rejects(async () => {
    for await (const event of chunks.read(frames(), signal())) delivered += Buffer.from(event.data, "base64").length;
  }, /voice_answer_too_large/);
  assert.ok(delivered > 0 && delivered <= 120 * 48_000); assert.equal(closed, true);
});

test("音声の再照合はchunkとfactの混在も一つのSQLで検証する", async t => {
  const { db, vector } = await setup(); t.after(() => db.close());
  const repository = new KnowledgeRepository(db, fixture.ownerId);
  const chunks = await repository.resolve([...vector.records.keys()]);
  const fact = (await repository.facts())[0];
  const exact: Evidence = { id: `fact:${fact.id}`, kind: "exact_fact", revisionId: fact.revision_id, documentId: fact.document_id,
    contentHash: fact.content_hash, content: fact.statement, entities: [], rank: 0, title: fact.fact_key };
  const evidence = [chunks[0], exact];
  let queries = 0;
  const prepare = db.prepare.bind(db);
  t.mock.method(db, "prepare", (sql: string) => { queries++; return prepare(sql); });
  assert.equal(await repository.revalidateSnapshot(evidence), true); assert.equal(queries, 1);
  assert.equal(await repository.revalidateSnapshot([{ ...chunks[0], contentHash: "changed" }, exact]), false);
  assert.equal(await repository.revalidateSnapshot([chunks[0], { ...exact, content: "改変された文章" }]), false);
  assert.equal(await new KnowledgeRepository(db, "different-owner").revalidateSnapshot(evidence), false);
  await db.prepare("UPDATE exact_facts SET approval_status='revoked'").run();
  assert.equal(await repository.revalidateSnapshot(evidence), false);
  assert.equal(await repository.revalidateSnapshot([chunks[0]]), true);
  await db.prepare("UPDATE knowledge_document_revisions SET visibility='private'").run();
  assert.equal(await repository.revalidateSnapshot([chunks[0]]), false);
});
