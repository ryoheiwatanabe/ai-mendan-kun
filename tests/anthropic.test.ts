import test from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider } from "../lib/ai/anthropic.ts";
import { answerSchema, answerSystemPrompt } from "../lib/ai/prompt.ts";
import type { AnswerProvider, ModelPayload } from "../lib/types.ts";

const key = "test-only-anthropic-dummy";
const input: Parameters<AnswerProvider["stream"]>[0] = {
  question: "仕事の進め方は？", history: [{ role: "assistant", content: "履歴も入力データ" }], highRisk: false,
  evidence: [{ id: "test-id", title: "承認済みの資料", content: "本人が承認した文です。", revisionId: "revision-id",
    documentId: "document-id", contentHash: "test-hash", entities: [], kind: "chunk", rank: 1 }]
};
const payload: ModelPayload = {
  segments: [{ kind: "fact", text: "日本語と絵文字🙂、引用符\"、括弧{}を含む文です。", evidenceIds: ["test-id"] }],
  answerability: "answerable", confidence: "high"
};
const messageStart = { type: "message_start", message: { type: "message", role: "assistant", content: [], stop_reason: null,
  usage: { input_tokens: 120, output_tokens: 1 } } };
const blockStart = { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
const blockStop = { type: "content_block_stop", index: 0 };
const messageStop = { type: "message_stop" };
const textDelta = (text: string, index = 0) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text } });
const messageDelta = (stop_reason: string | null = "end_turn", output_tokens = 17) => ({ type: "message_delta", delta: { stop_reason }, usage: { output_tokens } });
function events(text = JSON.stringify(payload)): unknown[] {
  return [messageStart, blockStart, textDelta(text), blockStop, messageDelta(), messageStop];
}
function wire(items: unknown[]) {
  return items.map(item => `event: ${(item as { type?: string })?.type ?? "unknown"}\r\ndata: ${JSON.stringify(item)}\r\n\r\n`).join("");
}
function response(items: unknown[], fragmentSize = 0) {
  const bytes = new TextEncoder().encode(wire(items));
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      const end = fragmentSize ? Math.min(offset + fragmentSize, bytes.length) : bytes.length;
      controller.enqueue(bytes.slice(offset, end)); offset = end;
    }
  }), { headers: { "Content-Type": "text/event-stream" } });
}
function run(signal = new AbortController().signal) {
  return Array.fromAsync(new AnthropicProvider(key).stream(input, signal));
}

test("Claudeは固定URL・認証ヘッダー・共通schemaを使い、履歴と根拠をデータとして渡す", async t => {
  const signal = new AbortController().signal;
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    assert.equal(url.includes(key), false);
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "manual");
    assert.equal(options.signal, signal);
    const headers = new Headers(options.headers);
    assert.equal(headers.get("x-api-key"), key);
    assert.equal(headers.get("anthropic-version"), "2023-06-01");
    assert.equal(headers.get("Content-Type"), "application/json");
    const body = JSON.parse(options.body as string);
    assert.equal(body.model, "claude-haiku-4-5-20251001");
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 1800);
    assert.equal(body.temperature, undefined);
    assert.equal(body.system, answerSystemPrompt);
    assert.deepEqual(body.output_config, { format: { type: "json_schema", schema: answerSchema } });
    assert.deepEqual(body.messages, [{ role: "user", content: JSON.stringify({ question: input.question, history: input.history,
      evidence: [{ id: "test-id", title: "承認済みの資料", content: "本人が承認した文です。" }] }) }]);
    assert.equal(body.tools, undefined);
    assert.equal(body.thinking, undefined);
    return response(events());
  });
  assert.deepEqual((await run(signal)).map(event => event.type), ["segment", "complete"]);
  assert.equal(new AnthropicProvider(key, "configured-claude-model").model, "configured-claude-model");
});

test("ClaudeはUTF-8・CRLF・SSE・JSONの分断を復元し、閉じたsegmentと累計usageを返す", async t => {
  const json = JSON.stringify(payload);
  const parts = Array.from({ length: Math.ceil(json.length / 3) }, (_, i) => textDelta(json.slice(i * 3, i * 3 + 3)));
  t.mock.method(globalThis, "fetch", async () => response([
    messageStart, { type: "ping" }, blockStart, ...parts, blockStop,
    { type: "future_metadata", metadata: "回答へ混ぜない" }, messageDelta(null, 9), messageDelta(), messageStop
  ], 1));
  const result = await run();
  assert.deepEqual(result, [{ type: "segment", segment: payload.segments[0] }, { type: "complete", payload, usage: { input: 120, output: 17 } }]);
});

test("Claudeはcontent blockを順番に結合し、message_stop前にsegmentを返す", async t => {
  const json = JSON.stringify(payload);
  const split = json.indexOf('],"answerability"') + 1;
  t.mock.method(globalThis, "fetch", async () => response([
    messageStart, blockStart, textDelta(json.slice(0, split)), blockStop,
    { type: "content_block_start", index: 1, content_block: { type: "text", text: json.slice(split) } },
    { type: "content_block_stop", index: 1 }, messageDelta(), messageStop
  ]));
  const iterator = new AnthropicProvider(key).stream(input, new AbortController().signal)[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { done: false, value: { type: "segment", segment: payload.segments[0] } });
  assert.equal((await iterator.next()).value?.type, "complete");
  assert.equal((await iterator.next()).done, true);
});

test("Claudeの根拠不足の回答は空segmentsのcompleteとして返せる", async t => {
  const unknown: ModelPayload = { segments: [], answerability: "unknown", confidence: "low" };
  t.mock.method(globalThis, "fetch", async () => response(events(JSON.stringify(unknown))));
  assert.deepEqual(await run(), [{ type: "complete", payload: unknown, usage: { input: 120, output: 17 } }]);
});

test("Claudeのenumだけを大小文字に関係なく検証し、原文と根拠IDは維持する", async t => {
  const segments = [
    { kind: "FaCt", text: "OpenAIとAPIのMiXeD Caseを保持します。", evidenceIds: ["Evidence-ID-A"] },
    { kind: "INTERPRETATION", text: "AIによる限定的な整理です。", evidenceIds: ["Evidence-ID-B"] }
  ];
  let state = "ANSWERABLE", confidence = "High";
  t.mock.method(globalThis, "fetch", async () => response(events(JSON.stringify({ segments, answerability: state, confidence }))));
  for (const [nextState, nextConfidence] of [["ANSWERABLE", "High"], ["Partial", "MEDIUM"], ["Unknown", "Low"], ["Ambiguous", "HIGH"]]) {
    state = nextState; confidence = nextConfidence;
    const result = await run();
    const normalized = segments.map(item => ({ ...item, kind: item.kind.toLowerCase() }));
    assert.deepEqual(result.slice(0, 2), normalized.map(segment => ({ type: "segment", segment })));
    assert.deepEqual(result.at(-1), { type: "complete", payload: { segments: normalized, answerability: state.toLowerCase(), confidence: confidence.toLowerCase() }, usage: { input: 120, output: 17 } });
  }
});

test("Claudeのenum補正は未知の値や空白付きの値を許可しない", async t => {
  let body: unknown = payload;
  t.mock.method(globalThis, "fetch", async () => response(events(JSON.stringify(body))));
  for (const invalid of [
    { ...payload, segments: [{ ...payload.segments[0], kind: "FACTUAL" }] },
    { ...payload, segments: [{ ...payload.segments[0], kind: " Fact" }] },
    { ...payload, answerability: "Maybe" }, { ...payload, confidence: "Certain" }, { ...payload, confidence: 1 }
  ]) {
    body = invalid;
    await assert.rejects(run(), /invalid_model_payload/);
  }
});

for (const [name, items, code] of [
  ["message_stopなし", events().slice(0, -1), "provider_incomplete"],
  ["end_turnなし", [...events().slice(0, -2), messageStop], "provider_incomplete"],
  ["トークン上限", [...events().slice(0, -2), messageDelta("max_tokens"), messageStop], "provider_incomplete"],
  ["拒否", [...events().slice(0, -2), messageDelta("refusal"), messageStop], "provider_refusal"],
  ["拒否delta", [messageStart, blockStart, { type: "content_block_delta", index: 0, delta: { type: "refusal_delta", refusal: key } }], "provider_refusal"],
  ["ストリーム内error", [...events().slice(0, -2), { type: "error", error: { type: "overloaded_error", message: key } }], "provider_stream_error"],
  ["message_startなし", events().slice(1), "invalid_provider_event"],
  ["block終了なし", [messageStart, blockStart, textDelta(JSON.stringify(payload)), messageDelta(), messageStop], "invalid_provider_event"],
  ["block開始なし", [messageStart, textDelta(JSON.stringify(payload)), ...events().slice(3)], "invalid_provider_event"],
  ["block index不一致", [messageStart, blockStart, textDelta(JSON.stringify(payload), 1), ...events().slice(3)], "invalid_provider_event"],
  ["重複block開始", [messageStart, blockStart, blockStart, ...events().slice(2)], "invalid_provider_event"],
  ["終了後の本文", [...events(), textDelta("extra")], "invalid_provider_event"],
  ["ツールblock", [messageStart, { type: "content_block_start", index: 0, content_block: { type: "tool_use" } }], "invalid_provider_event"],
  ["想定外のdelta", [messageStart, blockStart, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }], "invalid_provider_event"],
  ["不正usage", [messageStart, ...events().slice(1, -2), messageDelta("end_turn", -1), messageStop], "invalid_provider_event"],
  ["累計usage逆行", [...events().slice(0, -2), messageDelta(null, 100), messageDelta(), messageStop], "invalid_provider_event"],
  ["不正event形状", [null], "invalid_provider_event"]
] as const) {
  test(`Claudeは${name}をcompleteとして返さない`, async t => {
    t.mock.method(globalThis, "fetch", async () => response([...items]));
    const result: string[] = [];
    await assert.rejects(async () => {
      for await (const event of new AnthropicProvider(key).stream(input, new AbortController().signal)) result.push(event.type);
    }, error => error instanceof Error && error.message === code && !error.message.includes(key));
    assert.equal(result.includes("complete"), false);
  });
}

test("Claudeは不正JSON・payload・segment数とサイズ超過を成功として扱わない", async t => {
  let body = "";
  t.mock.method(globalThis, "fetch", async () => response(events(body)));
  for (const invalid of [
    `{"sensitive-provider-response": "${key}", invalid}`, "null", "[]",
    JSON.stringify({ ...payload, answerability: "invented" }), JSON.stringify({ ...payload, confidence: "invented" }),
    JSON.stringify({ ...payload, segments: [{ ...payload.segments[0], kind: "invented" }] }),
    JSON.stringify({ ...payload, segments: Array.from({ length: 5 }, () => payload.segments[0]) }),
    JSON.stringify({ ...payload, segments: [{ ...payload.segments[0], text: "x".repeat(24_000) }] })
  ]) {
    body = invalid;
    await assert.rejects(run(), error => error instanceof Error && !error.message.includes(key) && !error.message.includes("sensitive"));
  }
});

test("Claudeは壊れたSSE・巨大event・未完了frameを安全な例外にする", async t => {
  let body = "";
  t.mock.method(globalThis, "fetch", async () => new Response(body));
  for (const invalid of [
    `data: {"secret":"${key}", bad}\n\n`,
    `data: ${JSON.stringify({ type: "future_metadata", secret: "x".repeat(150_001) })}\n\n`,
    `data: ${"x".repeat(150_001)}`,
    `${wire(events())}data: {"unfinished":true}`
  ]) {
    body = invalid;
    await assert.rejects(run(), error => error instanceof Error && !error.message.includes(key) && error.message.length < 100);
  }
});

test("ClaudeのHTTPエラーとredirectは本文を読まず安全な分類だけ返す", async t => {
  let status = 401, cancelled = 0;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(`sensitive-provider-response-${key}`)); },
    cancel() { cancelled++; }
  }), { status }));
  for (const code of [401, 403, 429, 500, 302]) {
    status = code;
    await assert.rejects(run(), error => error instanceof Error && error.message === `answer_http_${code}`);
  }
  assert.equal(cancelled, 5);
});

test("Claudeの通信例外はAPIキーを含んでいても外部へ返さない", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error(`request failed ${key}`); });
  await assert.rejects(run(), error => error instanceof Error && error.message === "provider_stream_error");
});

test("Claudeはストリームの途中切断を成功にせずreaderを解放する", async t => {
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls++ === 0) controller.enqueue(new TextEncoder().encode(wire(events().slice(0, 3))));
      else controller.error(new Error(`sensitive-network-error-${key}`));
    }
  });
  t.mock.method(globalThis, "fetch", async () => new Response(stream));
  await assert.rejects(run(), error => error instanceof Error && error.message === "provider_stream_error");
  assert.equal(stream.locked, false);
});

test("Claudeは開始前とsegment送出後のAbortを完了扱いにせず、理由の自由文を返さない", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return response(events()); });
  const aborted = new AbortController(); aborted.abort(new Error(key));
  await assert.rejects(run(aborted.signal), error => error instanceof Error && error.message === "provider_aborted");
  assert.equal(calls, 0);
  const controller = new AbortController();
  const iterator = new AnthropicProvider(key).stream(input, controller.signal)[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, "segment");
  controller.abort(new Error(key));
  await assert.rejects(iterator.next(), error => error instanceof Error && error.message === "provider_aborted");
});
