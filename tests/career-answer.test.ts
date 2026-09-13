import test from "node:test";
import assert from "node:assert/strict";
import { answer } from "../lib/answer/engine.ts";
import { voiceAnswer } from "../lib/voice/answer.ts";
import { KnowledgeRepository } from "../lib/knowledge/repository.ts";
import { sha256 } from "../lib/knowledge/text.ts";
import { fixture, setup } from "./helpers.ts";
import type { AnswerProvider, ChatRequest } from "../lib/types.ts";
import type { SpeechProvider } from "../lib/voice/types.ts";

const question: ChatRequest = { mode: "meeting_text", message: "えっと、まずあなたの経歴を簡単に教えてください。", history: [] };
const summary = "要件整理と開発チームとの調整を経験しました。実装は外部エンジニアが担当しています。";
const forbidden = {
  async embed(): Promise<number[]> { throw new Error("unexpected_embedding"); },
  async *stream(): ReturnType<AnswerProvider["stream"]> { throw new Error("unexpected_generation"); }
};
async function context() {
  const result = await setup();
  const repository = new KnowledgeRepository(result.db, fixture.ownerId);
  const evidence = await repository.resolve(result.prepared.chunks.map(item => item.id));
  const sources = await Promise.all(evidence.map(async item => ({ id: item.id,
    fingerprint: await sha256(JSON.stringify([item.id, item.revisionId, item.documentId, item.title, item.content, item.contentHash])) })));
  const careerOverview = JSON.stringify({ version: 1, text: summary, reviewedBy: "ai", sources, sourceSet: await repository.sourceSet() });
  return { ...result, repository, careerOverview, embedding: forbidden, provider: forbidden };
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
  await assert.rejects(Array.fromAsync(answer({ ...question, message: "会社員時代は何を担当していましたか？" }, deps, new AbortController().signal)), /unexpected_embedding/);
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
  const text = (await iterator.next()).value;
  assert.ok(text?.type === "text" && text.text === summary);
  await deps.db.prepare("UPDATE knowledge_document_revisions SET approval_status='revoked' WHERE id=?").bind(deps.prepared.revisionId).run();
  await assert.rejects(iterator.next(), /voice_evidence_changed/);
  assert.equal(syntheses, 0);
});
