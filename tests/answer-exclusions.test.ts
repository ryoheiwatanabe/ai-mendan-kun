// 非表示対象（除外）の入口・履歴・派生概要・出力・音声の各境界を、架空の値だけで固定する。
// 実値はサーバーSecretにだけ置き、ここへは持ち込まない。
import test from "node:test";
import assert from "node:assert/strict";
import { answer } from "../lib/answer/engine.ts";
import { loadCareerOverview } from "../lib/answer/overview.ts";
import { voiceAnswer } from "../lib/voice/answer.ts";
import { KnowledgeRepository } from "../lib/knowledge/repository.ts";
import { excludedContentMask, excludedContentReply, getContentExclusions } from "../lib/security/content-exclusions.ts";
import { fixture, setup } from "./helpers.ts";
import type { AnswerProvider } from "../lib/types.ts";
import type { SpeechProvider } from "../lib/voice/types.ts";

const hidden = "ひみつラボ";
const policy = getContentExclusions({ USER_CONTENT_EXCLUSIONS: JSON.stringify({ version: 1,
  rules: [{ id: "hidden_lab", literal: hidden }] }) });
const question = "仕事の進め方を教えてください";
const request = { mode: "meeting_text" as const, message: question, history: [] };
const textsOf = (events: Array<{ type: string; text?: string }>) =>
  events.flatMap(event => event.type === "text" && typeof event.text === "string" ? [event.text] : []);
const countingEmbedding = (calls: { embedding: number }) => ({ async embed() { calls.embedding++; return [1, 0, 0]; } });

test("非表示の話題を直接聞かれたら、検索も生成も呼ばずに定型だけを返す", async t => {
  const data = await setup(); t.after(() => data.db.close());
  const calls = { stream: 0, embedding: 0 };
  const provider: AnswerProvider = { async *stream() { calls.stream++; throw new Error("provider_must_not_run"); } };
  const events = await Array.fromAsync(answer({ ...request, message: `${hidden}の話を教えて` },
    { provider, repository: new KnowledgeRepository(data.db, fixture.ownerId, policy), vector: data.vector,
      embedding: countingEmbedding(calls) }, new AbortController().signal));
  assert.deepEqual(calls, { stream: 0, embedding: 0 }, "生成も埋め込みも呼ばない");
  assert.deepEqual(textsOf(events), [excludedContentReply]);
  const input = events.find(event => event.type === "input") as { question?: string; blocked?: boolean } | undefined;
  assert.equal(input?.question, excludedContentMask, "原文をそのまま返さない");
  assert.equal(input?.blocked, true);
  assert.doesNotMatch(JSON.stringify(events), /ひみつラボ/);
});

test("同じ話題は音声でも同じ定型を返し、読み上げにも本文を混ぜない", async t => {
  const data = await setup(); t.after(() => data.db.close());
  const calls = { stream: 0, embedding: 0 };
  const spoken: string[] = [];
  const provider: AnswerProvider = { async *stream() { calls.stream++; throw new Error("provider_must_not_run"); } };
  const speech: SpeechProvider = { async transcribe() { throw new Error("transcribe_must_not_run"); },
    async *synthesize(text) { spoken.push(text); } };
  const events = await Array.fromAsync(voiceAnswer({ ...request, message: `${hidden}の話を教えて` },
    { provider, repository: new KnowledgeRepository(data.db, fixture.ownerId, policy), vector: data.vector,
      embedding: countingEmbedding(calls), speech }, new AbortController().signal));
  assert.deepEqual(calls, { stream: 0, embedding: 0 }, "テキストと同じく生成も埋め込みも呼ばない");
  assert.deepEqual(textsOf(events), [excludedContentReply]);
  assert.equal(spoken.join(""), excludedContentReply, "定型だけを読み上げる");
  assert.doesNotMatch(JSON.stringify(events), /ひみつラボ/);
});

test("非表示の話題を含む過去の往復は、生成へ渡す前に外す", async t => {
  const data = await setup(); t.after(() => data.db.close());
  const seen: string[][] = [];
  const provider: AnswerProvider = { async *stream(input) {
    seen.push(input.history.map(turn => turn.content));
    throw new Error("stop_after_capture");
  } };
  const events = await Array.fromAsync(answer({ ...request, history: [
    { role: "user", content: `${hidden}の話を教えて` }, { role: "assistant", content: `${hidden}についてお答えします。` },
    { role: "user", content: "仕事の進め方は？" }, { role: "assistant", content: "確認します。" }
  ] }, { provider, repository: new KnowledgeRepository(data.db, fixture.ownerId, policy), vector: data.vector,
    embedding: countingEmbedding({ embedding: 0 }) }, new AbortController().signal));
  assert.ok(seen.length >= 1, "質問自体は止めず、生成まで進む");
  for (const history of seen) assert.deepEqual(history, ["仕事の進め方は？", "確認します。"], "除外を含む往復だけを外す");
  assert.doesNotMatch(JSON.stringify(events), /ひみつラボ/);
});

test("派生概要に非表示の話題が混ざっていたら、そのキャッシュを使わない", async t => {
  const data = await setup(); t.after(() => data.db.close());
  const raw = JSON.stringify({ version: 1, text: `${hidden}の話です。`, reviewedBy: "ai",
    sources: [{ id: "rev_probe:0", fingerprint: "a".repeat(64) }],
    sourceSet: [{ documentId: "doc", revisionId: "rev", contentHash: "b".repeat(64) }] });
  assert.deepEqual(await loadCareerOverview(raw, new KnowledgeRepository(data.db, fixture.ownerId, policy)),
    { ok: false, reason: "content_excluded" });
  assert.deepEqual(await loadCareerOverview(raw, new KnowledgeRepository(data.db, fixture.ownerId)),
    { ok: false, reason: "sources_missing" }, "除外が無ければ理由は除外ではない");
});

test("推測で非表示の話題を書いた本文は、表示も読み上げもしない", async t => {
  const data = await setup(); t.after(() => data.db.close());
  const calls = { stream: 0 };
  const spoken: string[] = [];
  const provider: AnswerProvider = { async *stream() { calls.stream++;
    yield { type: "segment", segment: { kind: "grounded_synthesis", text: `${hidden}の話です。`, claims: [], evidenceIds: [] } }; } };
  const speech: SpeechProvider = { async transcribe() { throw new Error("transcribe_must_not_run"); },
    async *synthesize(text) { spoken.push(text); } };
  const deps = { provider, repository: new KnowledgeRepository(data.db, fixture.ownerId, policy), vector: data.vector,
    embedding: countingEmbedding({ embedding: 0 }) };
  const events = await Array.fromAsync(answer(request, deps, new AbortController().signal));
  assert.ok(calls.stream >= 1, "生成は呼ばれる");
  assert.deepEqual(textsOf(events), [], "推測で書いた本文を表示しない");
  assert.ok(events.some(event => event.type === "error"), "本文を出さずに失敗として返す");
  assert.doesNotMatch(JSON.stringify(events), /ひみつラボ/);
  const voiceEvents = await Array.fromAsync(voiceAnswer(request, { ...deps, speech }, new AbortController().signal));
  assert.deepEqual(textsOf(voiceEvents), [], "音声でも本文を出さない");
  assert.deepEqual(spoken, [], "読み上げもしない");
});
