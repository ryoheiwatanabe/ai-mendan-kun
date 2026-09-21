import test from "node:test";
import assert from "node:assert/strict";
import { answer } from "../lib/answer/engine.ts";
import { voiceAnswer } from "../lib/voice/answer.ts";
import { KnowledgeRepository } from "../lib/knowledge/repository.ts";
import { sha256 } from "../lib/knowledge/text.ts";
import { fixture, setup, embedding as fixtureEmbedding } from "./helpers.ts";
import { approveImport, prepareImport } from "../lib/knowledge/import.ts";
import type { AnswerProvider, ChatRequest, Diagnostic } from "../lib/types.ts";
import type { SpeechProvider, VoiceEvent } from "../lib/voice/types.ts";

const question: ChatRequest = { mode: "meeting_text", message: "えっと、まずあなたの経歴を簡単に教えてください。", history: [] };
const summary = "要件整理と開発チームとの調整を経験しました。実装は外部エンジニアが担当しています。";
const forbidden = {
  async embed(): Promise<number[]> { throw new Error("unexpected_embedding"); },
  async *stream(): ReturnType<AnswerProvider["stream"]> { throw new Error("unexpected_generation"); }
};
async function context(withUnreferencedDocument = false) {
  const result = await setup();
  let unreferencedRevision: string | undefined;
  if (withUnreferencedDocument) {
    const prepared = await prepareImport({ ...fixture, documentId: "additional", content: "# 別の経験\n\n別のチームで研修の準備を担当しました。", facts: [] });
    await approveImport({ db: result.db, vector: result.vector, embedding: fixtureEmbedding, prepared, approvalHash: prepared.hash, signal: new AbortController().signal });
    unreferencedRevision = prepared.revisionId;
  }
  const repository = new KnowledgeRepository(result.db, fixture.ownerId);
  const evidence = await repository.resolve(result.prepared.chunks.map(item => item.id));
  const sources = await Promise.all(evidence.map(async item => ({ id: item.id,
    fingerprint: await sha256(JSON.stringify([item.id, item.revisionId, item.documentId, item.title, item.content, item.contentHash])) })));
  const careerOverview = JSON.stringify({ version: 1, text: summary, reviewedBy: "ai", sources, sourceSet: await repository.sourceSet() });
  return { ...result, repository, careerOverview, unreferencedRevision, embedding: forbidden, provider: forbidden };
}

test("経歴概要は検索順位・会話履歴に左右されず、校閲した完成文を生成APIなしで返す", async t => {
  const deps = await context(); t.after(() => deps.db.close());
  const evidenceIds: string[] = [];
  const events = await Array.fromAsync(answer({ ...question, history: [{ role: "assistant", content: "私は社長で、実装もすべて担当しました。" }] },
    { ...deps, onEvidence: items => evidenceIds.push(...items.map(item => item.id)) }, new AbortController().signal));
  assert.equal(events.flatMap(event => event.type === "text" ? [event.text] : []).join(""), summary);
  assert.equal(evidenceIds.length, deps.prepared.chunks.length);
  const done = events.at(-1);
  assert.ok(done?.type === "done" && done.answerability === "answerable");
  assert.equal(done.retrievalSimilarityPercent, null);
});

test("特定時期の質問には、設定済みの経歴概要で代答しない", async t => {
  const deps = await context(); t.after(() => deps.db.close());
  let searched = false;
  const scoped = { ...deps, embedding: { async embed() { searched = true; throw new Error("test_search_failure"); } } };
  const events = await Array.fromAsync(answer({ ...question, message: "会社員時代は何を担当していましたか？" }, scoped, new AbortController().signal));
  assert.equal(searched, true, "限定した質問は全体概要で代答せず検索する");
  assert.equal(events.some(event => event.type === "text"), false);
  assert.equal(events.at(-1)?.type, "error");
});

test("丁寧な自己紹介依頼も音声経路から完成文を返し、検索生成へ落ちない", async t => {
  const deps = await context(); t.after(() => deps.db.close());
  const spoken: string[] = [];
  const speech: SpeechProvider = {
    async transcribe() { throw new Error("unexpected_transcription"); },
    async *synthesize(text) {
      spoken.push(text);
      yield { data: Buffer.alloc(12000).toString("base64"), mimeType: "audio/pcm", sampleRate: 24000, channels: 1 };
    }
  };
  const events = await Array.fromAsync(voiceAnswer({ ...question, message: "えっと、まず簡単な自己紹介をお願いできますか?" },
    { ...deps, speech }, new AbortController().signal));
  assert.equal(events.flatMap(event => event.type === "text" ? [event.text] : []).join(""), summary);
  assert.deepEqual(spoken, [summary]);
  assert.ok(events.some(event => event.type === "audio"));
  assert.ok(events.some(event => event.type === "done" && event.answerability === "answerable"));
});

test("派生紹介文を表示した直後に元資料が撤回されたら、TTSにも音声送信にも進まない", async t => {
  const deps = await context(); t.after(() => deps.db.close());
  let syntheses = 0;
  const speech: SpeechProvider = {
    async transcribe() { throw new Error("unexpected_transcription"); },
    async *synthesize() { syntheses++; yield { data: Buffer.alloc(12000).toString("base64"), mimeType: "audio/pcm", sampleRate: 24000, channels: 1 }; }
  };
  const iterator = voiceAnswer(question, { ...deps, speech }, new AbortController().signal);
  assert.equal((await iterator.next()).value?.type, "start");
  assert.equal((await iterator.next()).value?.type, "input", "理解した質問を先に知らせる");
  const text = (await iterator.next()).value;
  assert.ok(text?.type === "text" && text.text === summary);
  await deps.db.prepare("UPDATE knowledge_document_revisions SET approval_status='revoked' WHERE id=?").bind(deps.prepared.revisionId).run();
  await assert.rejects(iterator.next(), /voice_evidence_changed/);
  assert.equal(syntheses, 0);
});

test("TTS待機中に資料が追加されたら、概要の音声を送信しない", async t => {
  const deps = await context(); t.after(() => deps.db.close());
  const speech: SpeechProvider = {
    async transcribe() { throw new Error("unexpected_transcription"); },
    async *synthesize() {
      const prepared = await prepareImport({ ...fixture, documentId: "new-stage", content: "# 別の時期\n\n後の時期には相談窓口を担当しました。", facts: [] });
      await approveImport({ db: deps.db, vector: deps.vector, embedding: fixtureEmbedding, prepared, approvalHash: prepared.hash, signal: new AbortController().signal });
      yield { data: Buffer.alloc(12000).toString("base64"), mimeType: "audio/pcm", sampleRate: 24000, channels: 1 };
    }
  };
  const events: VoiceEvent[] = [];
  await assert.rejects(async () => {
    for await (const event of voiceAnswer(question, { ...deps, speech }, new AbortController().signal)) events.push(event);
  }, /voice_evidence_changed/);
  assert.equal(events.some(event => event.type === "audio"), false);
});

test("音声途中で未引用の資料が撤回されたら、以降の概要チャンクを送らない", async t => {
  const deps = await context(true); t.after(() => deps.db.close());
  const speech: SpeechProvider = {
    async transcribe() { throw new Error("unexpected_transcription"); },
    async *synthesize() {
      for (let i = 0; i < 2; i++) yield { data: Buffer.alloc(12000).toString("base64"), mimeType: "audio/pcm", sampleRate: 24000, channels: 1 };
    }
  };
  const iterator = voiceAnswer(question, { ...deps, speech }, new AbortController().signal);
  assert.equal((await iterator.next()).value?.type, "start");
  assert.equal((await iterator.next()).value?.type, "input", "理解した質問を先に知らせる");
  assert.equal((await iterator.next()).value?.type, "text");
  assert.equal((await iterator.next()).value?.type, "audio");
  await deps.db.prepare("UPDATE knowledge_document_revisions SET approval_status='revoked' WHERE id=?").bind(deps.unreferencedRevision).run();
  await assert.rejects(iterator.next(), /voice_evidence_changed/);
});

// 通常生成へ落ちた理由を実行記録から切り分けられるように、経路と概要キャッシュの状態を残す。
test("選んだ経路と、概要を使えなかった理由を実行記録へ残す", async t => {
  const hit = await context(); t.after(() => hit.db.close());
  const hitDiagnostics: Diagnostic[] = [];
  await Array.fromAsync(answer(question, { ...hit, diagnostics: value => hitDiagnostics.push(value) }, new AbortController().signal));
  assert.equal(hitDiagnostics.find(value => value.code === "route")?.reason, "overview");
  assert.equal(hitDiagnostics.find(value => value.code === "overview_cache")?.reason, "cache_hit");
  assert.ok(typeof hitDiagnostics.find(value => value.code === "overview_cache")?.latencyMs === "number");
  assert.ok(hitDiagnostics.some(value => value.code === "retrieval_complete") === false, "概要で答えたときは検索しない");

  const miss = await context(true); t.after(() => miss.db.close());
  // 参照範囲の資料が撤回されると、概要は現行性を確認できず通常経路へ落ちる。
  await miss.db.prepare("UPDATE knowledge_document_revisions SET approval_status='revoked' WHERE id=?").bind(miss.unreferencedRevision).run();
  const missDiagnostics: Diagnostic[] = [];
  // 通常経路では実際に検索するため、埋め込みは使えるものに差し替える（生成は検証対象外）。
  await Array.fromAsync(answer(question, { ...miss, embedding: fixtureEmbedding,
    diagnostics: value => missDiagnostics.push(value) }, new AbortController().signal));
  assert.equal(missDiagnostics.find(value => value.code === "route")?.reason, "retrieval");
  assert.equal(missDiagnostics.find(value => value.code === "overview_cache")?.reason, "snapshot_stale");
  assert.ok(missDiagnostics.some(value => value.code === "retrieval_complete"), "通常経路では検索の所要時間を残す");
});
