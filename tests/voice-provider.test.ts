import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GeminiSpeechProvider } from "../lib/voice/gemini.ts";
import { VOICE_MAX_WAV_BYTES } from "../lib/voice/types.ts";

const key = "voice-test-dummy-key";
const answer = "これは検証用の日本語の回答です。";
const signal = () => new AbortController().signal;
function wav(size = 3200) {
  const bytes = new Uint8Array(44 + size);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF")); view.setUint32(4, bytes.length - 8, true);
  bytes.set(new TextEncoder().encode("WAVEfmt "), 8); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 48_000, true);
  view.setUint32(28, 96_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode("data"), 36); view.setUint32(40, size, true);
  return bytes;
}
function transcript(text = `  ${answer}\n`) {
  return { status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text }] }],
    usage: { total_output_tokens: 20 } };
}
const start = { event_type: "interaction.created", interaction: { id: "test-interaction", status: "in_progress" } };
const format = { type: "audio", mime_type: "audio/l16", sample_rate: 24_000, channels: 1 };
const stepStart = { event_type: "step.start", index: 0, step: { type: "model_output", content: [format] } };
const stepStop = { event_type: "step.stop", index: 0 };
const complete = { event_type: "interaction.completed", interaction: { status: "completed", usage: { total_output_tokens: 10 } } };
const pcm = Buffer.from([0, 0, 255, 127, 0, 128, 0, 0]).toString("base64");
const delta = (data = pcm, other: Record<string, unknown> = {}) => ({ event_type: "step.delta", index: 0, delta: { type: "audio", data, ...other } });
function events() { return [start, stepStart, delta(), stepStop, complete]; }
function wire(items: unknown[]) {
  return items.map(event => `event: ${(event as { event_type?: string })?.event_type ?? "unknown"}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join("");
}
function streamResponse(items: unknown[], fragment = 0) {
  const bytes = new TextEncoder().encode(wire(items));
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = fragment ? Math.min(offset + fragment, bytes.length) : bytes.length;
      controller.enqueue(bytes.slice(offset, end)); offset = end;
    }
  }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}
function synthesize(abortSignal = signal(), text = answer) {
  return Array.fromAsync(new GeminiSpeechProvider(key).synthesize(text, abortSignal));
}
function classified(code: string) {
  return (error: unknown) => error instanceof Error && error.message === code
    && !error.message.includes(key) && !error.message.includes(answer);
}

test("音声STTは固定URL・既存キーのヘッダー・store:false・日本語WAV・token上限を使う", async t => {
  const abortSignal = signal();
  const recording = wav();
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/interactions");
    assert.equal(url.includes(key), false); assert.equal(options.redirect, "manual");
    assert.equal(options.method, "POST"); assert.equal(options.signal, abortSignal);
    const headers = new Headers(options.headers);
    assert.equal(headers.get("x-goog-api-key"), key);
    assert.equal(headers.get("Content-Type"), "application/json");
    const body = JSON.parse(options.body as string);
    assert.equal(body.model, "gemini-3.5-transcribe"); assert.equal(body.store, false);
    assert.deepEqual(body.input, [{ type: "audio", mime_type: "audio/wav", data: Buffer.from(recording).toString("base64") }]);
    assert.deepEqual(body.generation_config, { max_output_tokens: 512, transcription_config: { language_codes: ["ja-JP"], mode: { type: "verbatim" } } });
    assert.equal(body.previous_interaction_id, undefined); assert.equal(body.tools, undefined);
    return Response.json(transcript());
  });
  assert.deepEqual(await new GeminiSpeechProvider(key).transcribe(recording, abortSignal), { text: answer });
});

test("音声STTは3MBの録音もスタック上限を超えず完全なbase64へ変換する", async t => {
  const recording = wav(3_000_000); recording[44] = 131; recording[recording.length - 1] = 255;
  t.mock.method(globalThis, "fetch", async (_: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string);
    const bytes = Buffer.from(body.input[0].data, "base64");
    assert.equal(bytes.length, recording.length);
    assert.equal(bytes.compare(Buffer.from(recording)), 0);
    return Response.json(transcript());
  });
  assert.deepEqual(await new GeminiSpeechProvider(key).transcribe(recording, signal()), { text: answer });
});

test("音声STTは録音の空・上限超過・WAV以外・切断されたRIFFを送信前に拒否する", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(transcript()); });
  for (const recording of [new Uint8Array(), wav(VOICE_MAX_WAV_BYTES), new Uint8Array(100), wav().subarray(0, 100)])
    await assert.rejects(new GeminiSpeechProvider(key).transcribe(recording, signal()), classified("invalid_voice_recording"));
  assert.equal(calls, 0);
});

test("音声STTは複数textを結合してtrimし、1000文字まで返す", async t => {
  let result = transcript();
  t.mock.method(globalThis, "fetch", async () => Response.json(result));
  result.steps[0].content = [{ type: "text", text: "\n質問は" }, { type: "text", text: "こちらです。\n" }];
  assert.deepEqual(await new GeminiSpeechProvider(key).transcribe(wav(), signal()), { text: "質問はこちらです。" });
  result = transcript(`  ${"あ".repeat(1000)} `);
  assert.equal((await new GeminiSpeechProvider(key).transcribe(wav(), signal())).text.length, 1000);
});

test("音声STTは未完了・拒否・音声なし・過長・不正usage・旧schemaを正常な質問にしない", async t => {
  let result: unknown = transcript();
  t.mock.method(globalThis, "fetch", async () => Response.json(result));
  for (const invalid of [
    { ...transcript(), status: "incomplete" }, { ...transcript(), status: "failed" },
    { ...transcript(), errors: [{ message: key }] }, { ...transcript(), usage: { total_output_tokens: 513 } },
    { ...transcript(), usage: { total_output_tokens: -1 } }, { ...transcript(), usage: { total_output_tokens: 1.5 } },
    { ...transcript(), steps: [{ type: "model_output", content: [{ type: "refusal", text: answer }] }] },
    { ...transcript(), steps: [{ type: "user_input", content: [{ type: "text", text: answer }] }] },
    { ...transcript(), steps: [] }, transcript("  \n"), transcript("あ".repeat(1001)),
    { status: "completed", outputs: [{ type: "text", text: answer }] }, null
  ]) {
    result = invalid;
    await assert.rejects(new GeminiSpeechProvider(key).transcribe(wav(), signal()), error => error instanceof Error
      && error.message.length < 100 && !error.message.includes(key) && !error.message.includes(answer));
  }
});

test("音声STTは不正JSONと巨大レスポンスを本文を漏らさず拒否する", async t => {
  let responseBody = "";
  t.mock.method(globalThis, "fetch", async () => new Response(responseBody, { headers: { "Content-Type": "application/json" } }));
  for (const body of [`{invalid ${key} ${answer}`, JSON.stringify({ text: "あ".repeat(30_000) })]) {
    responseBody = body;
    await assert.rejects(new GeminiSpeechProvider(key).transcribe(wav(), signal()), error => error instanceof Error
      && error.message.length < 100 && !error.message.includes(key) && !error.message.includes(answer));
  }
});

test("音声TTSは検証済み文章だけを固定声・専用audio指定・store:false・1024token上限で送る", async t => {
  const abortSignal = signal();
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/interactions");
    assert.equal(options.redirect, "manual"); assert.equal(options.signal, abortSignal);
    const headers = new Headers(options.headers);
    assert.equal(headers.get("x-goog-api-key"), key); assert.equal(headers.get("Accept"), "text/event-stream");
    const body = JSON.parse(options.body as string);
    assert.deepEqual(body, { model: "gemini-3.1-flash-tts-preview", input: answer, stream: true,
      response_format: { type: "audio" },
      generation_config: { max_output_tokens: 1024, speech_config: [{ voice: "Kore" }] }, store: false });
    return streamResponse(events());
  });
  assert.deepEqual(await synthesize(abortSignal), [{ data: pcm, mimeType: "audio/pcm", sampleRate: 24_000, channels: 1 }]);
  const custom = new GeminiSpeechProvider(key, { sttModel: "test-stt", ttsModel: "test-tts", voice: "Charon" });
  assert.equal(custom.sttModel, "test-stt"); assert.equal(custom.ttsModel, "test-tts"); assert.equal(custom.voice, "Charon");
});

test("音声TTSは実APIの開始metadata・43delta・usage付き完了のSSE形式を処理する", async t => {
  // 2026-09-10の合成filler応答。全eventの順序/metadataを保持し、音声bytesは検証PCMへ置換。
  const observed = readFileSync(new URL("./fixtures/gemini-tts-observed.sse", import.meta.url), "utf8");
  t.mock.method(globalThis, "fetch", async () => new Response(observed, { headers: { "Content-Type": "text/event-stream" } }));
  const chunks = await synthesize();
  assert.equal(chunks.length, 43);
  assert.deepEqual(chunks, Array.from({ length: 43 }, () => ({ data: pcm, mimeType: "audio/pcm", sampleRate: 24_000, channels: 1 })));
});

test("音声TTSはSSEとCRLFの分断を復元し、同じstepの音声形式を継承する", async t => {
  const pcm2 = Buffer.from([10, 0, 25, 0]).toString("base64");
  t.mock.method(globalThis, "fetch", async () => streamResponse([
    start, { event_type: "ping", text: "日本語のメタデータ" }, stepStart, delta(), delta(pcm2), stepStop,
    { event_type: "interaction.status_update", status: "completed" }, complete
  ], 1));
  assert.deepEqual((await synthesize()).map(audio => audio.data), [pcm, pcm2]);
});

test("音声TTSは完了イベントを待たずにPCMを返し、その後の正常完了を検査する", async t => {
  let producer!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { producer = controller; } });
  t.mock.method(globalThis, "fetch", async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
  producer.enqueue(new TextEncoder().encode(wire([start, stepStart, delta()])));
  const iterator = new GeminiSpeechProvider(key).synthesize(answer, signal());
  const first = await iterator.next();
  assert.equal(first.done, false); assert.equal(first.value?.data, pcm);
  producer.enqueue(new TextEncoder().encode(wire([stepStop, complete]))); producer.close();
  assert.equal((await iterator.next()).done, true);
});

test("音声TTSはstep開始時の音声と最初のdeltaに付くmetadataの両方に対応する", async t => {
  let items: unknown[] = [start, { ...stepStart, step: { type: "model_output", content: [{ ...format, data: pcm }] } }, stepStop, complete];
  t.mock.method(globalThis, "fetch", async () => streamResponse(items));
  assert.equal((await synthesize())[0].data, pcm);
  items = [start, { ...stepStart, step: { type: "model_output" } }, delta(pcm, format), stepStop, complete];
  assert.equal((await synthesize())[0].data, pcm);
});

for (const [name, items, code] of [
  ["完了なし", events().slice(0, -1), "voice_provider_incomplete"],
  ["stream内error", [start, { event_type: "error", error: { message: key } }], "voice_provider_error"],
  ["失敗状態", [start, { event_type: "interaction.status_update", status: "failed" }], "voice_provider_incomplete"],
  ["上限終了", [...events().slice(0, -1), { ...complete, interaction: { status: "incomplete" } }], "voice_provider_incomplete"],
  ["過剰usage", [...events().slice(0, -1), { ...complete, interaction: { status: "completed", usage: { total_output_tokens: 1025 } } }], "invalid_voice_usage"],
  ["音声なし", [start, stepStart, stepStop, complete], "voice_audio_missing"],
  ["開始なし", events().slice(1), "invalid_voice_event"],
  ["step終了なし", [start, stepStart, delta(), complete], "voice_provider_incomplete"],
  ["step index不一致", [start, stepStart, { ...delta(), index: 1 }], "invalid_voice_event"],
  ["開始の重複", [start, start], "invalid_voice_event"],
  ["完了後の音声", [...events(), delta()], "invalid_voice_event"],
  ["文字や拒否文", [start, stepStart, { ...delta(), delta: { type: "text", text: answer } }], "invalid_voice_audio"],
  ["形式未指定", [start, { ...stepStart, step: { type: "model_output" } }, delta()], "unsupported_voice_audio"],
  ["ステレオ", [start, stepStart, delta(pcm, { channels: 2 })], "unsupported_voice_audio"],
  ["サンプルレート違い", [start, stepStart, delta(pcm, { sample_rate: 48_000 })], "unsupported_voice_audio"],
  ["WAVや圧縮音声", [start, stepStart, delta(pcm, { mime_type: "audio/wav" })], "unsupported_voice_audio"],
  ["URI形式", [start, stepStart, delta(pcm, { uri: "https://example.invalid/audio" })], "invalid_voice_audio"],
  ["base64不正", [start, stepStart, delta("%%%=")], "invalid_voice_audio"],
  ["不正padding", [start, stepStart, delta("AAF=")], "invalid_voice_audio"],
  ["PCM sampleの途中切れ", [start, stepStart, delta(Buffer.from([0]).toString("base64"))], "invalid_voice_audio"],
  ["record以外のevent", [null], "invalid_voice_event"]
] as const) {
  test(`音声TTSは${name}を成功として扱わない`, async t => {
    t.mock.method(globalThis, "fetch", async () => streamResponse([...items]));
    await assert.rejects(synthesize(), classified(code));
  });
}

test("音声TTSはPCM累計・単一event・stream総量の上限を超える音声を拒否する", async t => {
  const largeChunk = Buffer.alloc(90_000).toString("base64");
  let items: unknown[] = [start, stepStart, ...Array.from({ length: 22 }, () => delta(largeChunk)), stepStop, complete];
  t.mock.method(globalThis, "fetch", async () => streamResponse(items));
  await assert.rejects(synthesize(), classified("voice_audio_too_large"));
  items = [start, stepStart, delta(Buffer.alloc(120_000).toString("base64")), stepStop, complete];
  await assert.rejects(synthesize(), classified("voice_response_too_large"));
  items = Array.from({ length: 40 }, () => ({ event_type: "ping", metadata: "x".repeat(100_000) }));
  await assert.rejects(synthesize(), classified("voice_response_too_large"));
});

test("音声TTSは不正JSON・未完了SSEを秘密を含まない例外に変える", async t => {
  let body = "";
  t.mock.method(globalThis, "fetch", async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
  for (const invalid of [`data: {${key} ${answer}}\n\n`, `${wire(events())}data: {"unfinished":true}`]) {
    body = invalid;
    await assert.rejects(synthesize(), classified("voice_provider_error"));
  }
});

test("音声TTSは無効な文章を外部へ送らない", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return streamResponse(events()); });
  for (const invalid of ["", "\n ", "あ".repeat(1001)]) await assert.rejects(synthesize(signal(), invalid), classified("invalid_voice_text"));
  assert.equal(calls, 0);
});

test("音声APIのHTTPエラー・redirect・MIME違いは本文を読まず分類だけ返す", async t => {
  let status = 401, mime = "application/json", cancels = 0;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(`${key} ${answer}`)); },
    cancel() { cancels++; }
  }), { status, headers: { "Content-Type": mime } }));
  for (const code of [401, 403, 429, 500, 302]) {
    status = code;
    await assert.rejects(new GeminiSpeechProvider(key).transcribe(wav(), signal()), classified(`voice_http_${code}`));
    await assert.rejects(synthesize(), classified(`voice_http_${code}`));
  }
  status = 200; mime = "text/html";
  await assert.rejects(synthesize(), classified("invalid_voice_response"));
  assert.equal(cancels, 11);
});

test("音声APIは開始前Abortと任意の通信例外に秘密を含めない", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error(`${key} ${answer}`); });
  const aborted = new AbortController(); aborted.abort(new Error(key));
  await assert.rejects(new GeminiSpeechProvider(key).transcribe(wav(), aborted.signal), classified("voice_provider_aborted"));
  await assert.rejects(synthesize(aborted.signal), classified("voice_provider_aborted")); assert.equal(calls, 0);
  await assert.rejects(new GeminiSpeechProvider(key).transcribe(wav(), signal()), classified("voice_provider_error"));
  await assert.rejects(synthesize(), classified("voice_provider_error"));
});

test("音声TTSは再生途中のAbortでreaderを解放し以降の音声を返さない", async t => {
  const controller = new AbortController(); let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(new TextEncoder().encode(wire([start, stepStart, delta()]))); },
    cancel() { cancelled = true; }
  });
  t.mock.method(globalThis, "fetch", async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
  const iterator = new GeminiSpeechProvider(key).synthesize(answer, controller.signal);
  assert.equal((await iterator.next()).done, false);
  const pending = iterator.next(); controller.abort(new Error(`${key} ${answer}`));
  await assert.rejects(pending, classified("voice_provider_aborted"));
  assert.equal(body.locked, false); assert.equal(cancelled, true);
});

test("音声TTSはネットワーク途中切断で成功せずreaderを解放する", async t => {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls++ === 0) controller.enqueue(new TextEncoder().encode(wire([start, stepStart, delta()])));
      else controller.error(new Error(`${key} ${answer}`));
    }
  });
  t.mock.method(globalThis, "fetch", async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
  await assert.rejects(synthesize(), classified("voice_provider_error")); assert.equal(body.locked, false);
});
