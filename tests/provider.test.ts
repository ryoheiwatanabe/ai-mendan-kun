import test from "node:test";
import assert from "node:assert/strict";
import { OpenAIProvider } from "../lib/ai/openai.ts";
import { GeminiProvider } from "../lib/ai/gemini.ts";
import { createAnswerProvider, createEmbeddingProvider, embeddingSignature } from "../lib/ai/providers.ts";
import { assertEmbeddingSignature } from "../lib/knowledge/index-config.ts";
import { adminErrorCode } from "../lib/security/admin-error.ts";
import type { Bindings } from "../lib/types.ts";
import { LocalDatabase, setup } from "./helpers.ts";

const input = { question: "仕事の進め方は？", history: [], evidence: [], highRisk: false };
function response(text: string) {
  const events = [];
  for (let i = 0; i < text.length; i += 7) events.push({ choices: [{ delta: { content: text.slice(i, i + 7) }, finish_reason: null }] });
  events.push({ choices: [{ delta: { content: "" }, finish_reason: "stop" }] });
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
}

test("OpenAI Providerはstore:falseと構造化出力を指定し、閉じたsegmentを返す", async t => {
  let body: Record<string, unknown> | undefined;
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    body = JSON.parse(options.body as string);
    assert.equal(options.redirect, "manual", "認証付きリクエストを別URLへ自動転送しない");
    return response(JSON.stringify({ segments: [{ kind: "fact", text: "本人が承認した文です。", evidenceIds: ["test-id"] }], answerability: "answerable", confidence: "high" }));
  });
  const events = await Array.fromAsync(new OpenAIProvider("test-only-dummy").stream(input, new AbortController().signal));
  assert.equal(body?.store, false);
  assert.equal(body?.stream, true);
  assert.equal((body?.response_format as { type: string }).type, "json_schema");
  assert.deepEqual(events.map(event => event.type), ["segment", "complete"]);
});

test("Providerのエラー本文を利用者向け例外へ含めない", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response("sensitive-provider-response", { status: 401 }));
  await assert.rejects(Array.fromAsync(new OpenAIProvider("test-only-dummy").stream(input, new AbortController().signal)), error => {
    assert.match(String(error), /answer_http_401/);
    assert.equal(String(error).includes("sensitive"), false); return true;
  });
});

test("トークン上限で途切れた出力をcompleteとして返さない", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'));
  await assert.rejects(Array.fromAsync(new OpenAIProvider("test-only-dummy").stream(input, new AbortController().signal)), /incomplete/);
});

test("Embeddingの次元不足や非数値を検索へ渡さない", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ embedding: [1, 0] }] }));
  await assert.rejects(new OpenAIProvider("test-only-dummy", undefined, undefined, 1536).embed("テスト"), /invalid_embedding/);
});

test("Geminiの構造化ストリームは思考を除外し、キーをURLへ含めず完結したsegmentだけ返す", async t => {
  let body: any, headers: any, url = "";
  const payload = JSON.stringify({ segments: [{ kind: "fact", text: "確認された文です。", evidenceIds: ["test-id"] }], answerability: "answerable", confidence: "high" });
  t.mock.method(globalThis, "fetch", async (target: string, options: RequestInit) => {
    url = target; body = JSON.parse(options.body as string); headers = options.headers;
    assert.equal(Object.hasOwn(options, "cache"), false, "管理RPCからのnative fetchでも動くこと");
    assert.equal(options.redirect, "manual", "Workersが非対応のredirect:errorを指定しない");
    const events = [{ candidates: [{ content: { parts: [{ thought: true, text: "表示してはいけない思考" }] } }] }];
    for (let i = 0; i < payload.length; i += 5) events.push({ candidates: [{ content: { parts: [{ text: payload.slice(i, i + 5) }] } }] } as any);
    events.push({ candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30, thoughtsTokenCount: 20 } } as any);
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
  const events = await Array.fromAsync(new GeminiProvider("test-only-dummy").stream(input, new AbortController().signal));
  assert.equal(url.includes("test-only-dummy"), false);
  assert.equal(headers["x-goog-api-key"], "test-only-dummy");
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.equal(body.generationConfig.thinkingConfig.includeThoughts, false);
  assert.equal(body.generationConfig.maxOutputTokens, 4096);
  assert.deepEqual(events.map(event => event.type), ["segment", "complete"]);
  assert.equal(JSON.stringify(events).includes("表示してはいけない"), false);
  const last = events.at(-1);
  assert.deepEqual(last?.type === "complete" ? last.usage : null, { input: 100, output: 50 });
});

test("Geminiの打ち切り・ブロック・HTTPエラーを成功や詳細漏洩として扱わない", async t => {
  let response = new Response('data: {"candidates":[{"finishReason":"MAX_TOKENS"}]}\n\n');
  t.mock.method(globalThis, "fetch", async () => response);
  const run = () => Array.fromAsync(new GeminiProvider("test-only-dummy").stream(input, new AbortController().signal));
  await assert.rejects(run(), /provider_incomplete/);
  response = new Response('data: {"promptFeedback":{"blockReason":"SAFETY"}}\n\n');
  await assert.rejects(run(), /provider_refusal/);
  response = new Response("sensitive-provider-response", { status: 403 });
  await assert.rejects(run(), error => /answer_http_403/.test(String(error)) && !String(error).includes("sensitive"));
});

test("Geminiの検索質問と登録文で埋め込み形式を分け、有限の正規化ベクトルだけ返す", async t => {
  const requests: any[] = [];
  t.mock.method(globalThis, "fetch", async (_target: string, options: RequestInit) => {
    requests.push(JSON.parse(options.body as string));
    return Response.json({ embedding: { values: [3, 4, 0] } });
  });
  const provider = new GeminiProvider("test-only-dummy", undefined, undefined, 3);
  assert.deepEqual(await provider.embed("質問"), [.6, .8, 0]);
  await provider.embed("登録文", undefined, "document");
  assert.match(requests[0].content.parts[0].text, /^task: question answering \| query:/);
  assert.match(requests[1].content.parts[0].text, /^title: none \| text:/);
  assert.equal(requests[0].taskType, undefined);
  assert.equal(requests[0].outputDimensionality, 3);
});

test("Geminiのゼロベクトルや不足次元は検索へ渡さない", async t => {
  let vector = [0, 0, 0];
  t.mock.method(globalThis, "fetch", async () => Response.json({ embedding: { values: vector } }));
  const provider = new GeminiProvider("test-only-dummy", undefined, undefined, 3);
  await assert.rejects(provider.embed("質問"), /invalid_embedding/);
  vector = [1]; await assert.rejects(provider.embed("質問"), /invalid_embedding/);
});

test("Geminiの利用枠エラーはゼロ・無料枠・日次だけを分類し、キーや本文や識別子を管理RPCへ返さない", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: {
    status: "RESOURCE_EXHAUSTED", message: "test-only-private-key-and-document",
    details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{
      quotaId: "EmbedRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "0",
      quotaDimensions: { project: "private-project" }
    }] }, { reason: "unexpected-private-reason", metadata: { key: "test-only-private-key" } }]
  } }, { status: 429 }));
  await assert.rejects(new GeminiProvider("test-only-dummy").embed("テスト"), error => {
    assert.equal(adminErrorCode(error), "embedding_http_429_RESOURCE_EXHAUSTED_QUOTA_ZERO_QUOTA_FREE_TIER_QUOTA_DAILY");
    assert.equal(String(error).includes("private"), false);
    return true;
  });
});

test("GeminiのエラーJSONがnullや未知の形でもHTTP分類を失わない", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response("null", { status: 429 }));
  await assert.rejects(new GeminiProvider("test-only-dummy").embed("テスト"), error => adminErrorCode(error) === "embedding_http_429");
});

test("回答と埋め込みを別々に選択でき、未登録キーを別Providerへ自動fallbackしない", () => {
  const env = { ANSWER_PROVIDER: "openai", ANSWER_MODEL: "gpt-4.1-mini", EMBEDDING_PROVIDER: "gemini", EMBEDDING_MODEL: "gemini-embedding-2",
    OPENAI_API_KEY: "test-openai", GEMINI_API_KEY: "test-gemini" } as Bindings;
  assert.ok(createAnswerProvider(env) instanceof OpenAIProvider);
  assert.ok(createEmbeddingProvider(env) instanceof GeminiProvider);
  assert.throws(() => createAnswerProvider({ ...env, OPENAI_API_KEY: undefined }), /not_configured/);
  assert.throws(() => createAnswerProvider({ ...env, ANSWER_PROVIDER: "unsupported" }), /unsupported_provider/);
});

test("回答モデルの交換で検索空間は変わらず、埋め込み交換では旧indexの使用を止める", async () => {
  const db = new LocalDatabase();
  try {
    const env = { ANSWER_PROVIDER: "gemini", EMBEDDING_PROVIDER: "gemini", EMBEDDING_MODEL: "gemini-embedding-2" } as Bindings;
    const signature = embeddingSignature(env);
    await assert.rejects(assertEmbeddingSignature(db, "owner", signature), /mismatch/);
    await assertEmbeddingSignature(db, "owner", signature, true);
    assert.equal(embeddingSignature({ ...env, ANSWER_PROVIDER: "openai", ANSWER_MODEL: "gpt-4.1-mini" }), signature);
    await assertEmbeddingSignature(db, "owner", signature);
    await assert.rejects(assertEmbeddingSignature(db, "owner", embeddingSignature({ ...env, EMBEDDING_PROVIDER: "openai", EMBEDDING_MODEL: "text-embedding-3-small" }), true), /mismatch/);
  } finally { db.close(); }
});

test("検索空間の記録がない既存データを、設定だけで別モデルのindexとして承認しない", async () => {
  const { db } = await setup();
  try { await assert.rejects(assertEmbeddingSignature(db, "test-owner", "gemini:other:1536:retrieval-v1", true), /mismatch/); }
  finally { db.close(); }
});
