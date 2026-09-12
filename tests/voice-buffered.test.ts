import test from "node:test";
import assert from "node:assert/strict";
import { GeminiSpeechProvider } from "../lib/voice/gemini.ts";

const format = { type: "audio", mime_type: "audio/l16", sample_rate: 24_000, channels: 1 };
const piece = (bytes = Buffer.from([1, 0, 2, 0])) => ({ ...format, data: bytes.toString("base64") });
const payload = (content: unknown[] = [piece()]) => ({ status: "completed", usage: { total_output_tokens: 50 },
  steps: [{ type: "model_output", content }] });
const provider = () => new GeminiSpeechProvider("test-only-dummy");
const run = (signal = new AbortController().signal) => provider().synthesize("検証用の文章です。", signal);

test("bufferedが既定で、同じGoogleへstore:falseと出力量制限を送り、全PCMを順序どおり分割する", async t => {
  const first = Buffer.alloc(240_002, 1), second = Buffer.from([4, 0, 5, 0]);
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/interactions");
    assert.equal(init.redirect, "manual");
    const body = JSON.parse(init.body as string);
    assert.equal(body.stream, false); assert.equal(body.store, false);
    assert.deepEqual(body.response_format, { type: "audio" });
    assert.equal(body.generation_config.max_output_tokens, 1024);
    assert.equal(new Headers(init.headers).get("Accept"), "application/json");
    return Response.json(payload([{ ...piece(first), mime_type: 'audio/L16;codec=pcm;rate=24000;channels="1"' }, piece(second)]));
  });
  assert.equal(provider().ttsMode, "buffered");
  const chunks = await Array.fromAsync(run());
  const bytes = chunks.map(chunk => Buffer.from(chunk.data, "base64"));
  assert.deepEqual(bytes.map(value => value.length), [96_000, 96_000, 48_002, 4]);
  assert.deepEqual(Buffer.concat(bytes), Buffer.concat([first, second]));
});

test("bufferedは後半の不正・未完了・過剰usageを先頭のPCM送信前に拒否する", async t => {
  let value: unknown;
  t.mock.method(globalThis, "fetch", async () => Response.json(value));
  for (const invalid of [
    { ...payload(), status: "incomplete" }, { ...payload(), error: { message: "private-error" } },
    { ...payload(), usage: { total_output_tokens: 1025 } }, { ...payload(), usage: { total_output_tokens: -1 } },
    { ...payload(), steps: [{ type: "user_input", content: [piece()] }] },
    payload([piece(), { type: "text", text: "非音声" }]), payload([])
  ]) {
    value = invalid;
    await assert.rejects(run().next(), error => error instanceof Error && !error.message.includes("private-error"));
  }
});

test("bufferedは音声形式・不正base64・奇数PCM・URIを先頭送信前に拒否する", async t => {
  let value: unknown;
  t.mock.method(globalThis, "fetch", async () => Response.json(value));
  for (const invalid of [
    { mime_type: "audio/wav" }, { mime_type: "audio/l16;rate=48000" },
    { mime_type: "audio/l16;codec=opus" }, { mime_type: "audio/l16;channels=2" },
    { mime_type: "audio/l16;unknown=1" }, { sample_rate: 48_000 }, { channels: 2 }, { data: "%%%=" },
    { data: "AAF=" }, { data: "AQ==" }, { data: 123 }, { uri: "https://example.invalid/audio" },
    // 片ごとには正しいが、単一base64としては途中paddingを持つ場合も拒否する。
    { data: Buffer.alloc(95_998).toString("base64") + piece().data }
  ]) {
    value = payload([piece(), { ...piece(), ...invalid }]);
    await assert.rejects(run().next(), /voice_audio/);
  }
});

test("bufferedは全体のPCM量を検証し、累計上限を超える音声を一部も送らない", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json(payload([piece(Buffer.alloc(1_000_000)), piece(Buffer.alloc(1_000_000))])));
  await assert.rejects(run().next(), /voice_audio_too_large/);
});

test("bufferedはContent-Lengthに頼らず実受信3.5MBで停止する", async t => {
  let cancelled = 0;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(500_001)); }, cancel() { cancelled++; }
  }), { headers: { "Content-Type": "application/json", "Content-Length": "1" } }));
  await assert.rejects(run().next(), /voice_response_too_large/);
  assert.equal(cancelled, 1);
});

test("bufferedは受信中のAbortで終了して音声を返さない", async t => {
  let cancelled = false;
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream<Uint8Array>({
    start(output) { output.enqueue(new TextEncoder().encode('{"status":')); }, cancel() { cancelled = true; }
  }), { headers: { "Content-Type": "application/json" } }));
  const pending = run(controller.signal).next();
  await new Promise(resolve => setTimeout(resolve, 0)); controller.abort();
  await assert.rejects(pending, /voice_provider_aborted/);
  assert.equal(cancelled, true);
});

test("bufferedは分割音声の送出中もAbort後の片を返さない", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json(payload([piece(Buffer.alloc(200_000))])));
  const controller = new AbortController(), iterator = run(controller.signal);
  assert.equal((await iterator.next()).done, false);
  controller.abort();
  await assert.rejects(iterator.next(), /voice_provider_aborted/);
});
