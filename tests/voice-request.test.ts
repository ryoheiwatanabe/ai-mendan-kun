import test from "node:test";
import assert from "node:assert/strict";
import { readRecording, validateRecording } from "../lib/voice/request.ts";
import { PublicError } from "../lib/security/request.ts";
import { VOICE_MAX_SECONDS, VOICE_MAX_WAV_BYTES } from "../lib/voice/types.ts";

function wav(rate = 16_000, frames = rate) {
  const bytes = new Uint8Array(44 + frames * 2), view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF")); view.setUint32(4, bytes.length - 8, true);
  bytes.set(new TextEncoder().encode("WAVEfmt "), 8); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode("data"), 36); view.setUint32(40, frames * 2, true);
  return bytes;
}
function publicError(code: string, status: number) {
  return (error: unknown) => error instanceof PublicError && error.code === code && error.status === status;
}
function request(body: ReadableStream<Uint8Array> | Uint8Array | null, headers: Record<string, string> = { "Content-Type": "audio/wav" }) {
  return new Request("https://voice.test/api/voice/transcribe", { method: "POST", headers, body, duplex: "half" } as RequestInit);
}
const signal = () => new AbortController().signal;

test("録音受付はPCM16 monoの最短・最長・対応レート境界を受け入れる", () => {
  for (const rate of [8_000, 16_000, 48_000]) {
    for (const frames of [rate * .15, rate, rate * VOICE_MAX_SECONDS]) {
      const recording = wav(rate, frames);
      assert.equal(validateRecording(recording), recording);
    }
  }
  const original = wav(), padded = new Uint8Array(original.length + 12);
  padded.set(original, 5);
  assert.deepEqual(validateRecording(padded.subarray(5, 5 + original.length)), original);
});

test("録音受付はWAVの偽装・圧縮・ステレオ・サイズ不整合を拒否する", () => {
  const variants: [string, (bytes: Uint8Array, view: DataView) => void][] = [
    ["RIFF以外", bytes => { bytes[0] = 0; }],
    ["WAVE以外", bytes => { bytes[8] = 0; }],
    ["fmt以外", bytes => { bytes[12] = 0; }],
    ["data以外", bytes => { bytes[36] = 0; }],
    ["RIFF長の偽装", (_, view) => view.setUint32(4, 100, true)],
    ["拡張fmt", (_, view) => view.setUint32(16, 18, true)],
    ["浮動小数点音声", (_, view) => view.setUint16(20, 3, true)],
    ["ステレオ", (_, view) => view.setUint16(22, 2, true)],
    ["byte rate不一致", (_, view) => view.setUint32(28, 16_000, true)],
    ["block align不一致", (_, view) => view.setUint16(32, 4, true)],
    ["8bit音声", (_, view) => view.setUint16(34, 8, true)],
    ["data長の偽装", (_, view) => view.setUint32(40, 1, true)]
  ];
  for (const [name, change] of variants) {
    const recording = wav(); change(recording, new DataView(recording.buffer));
    assert.throws(() => validateRecording(recording), publicError("INVALID_AUDIO", 400), name);
  }
  for (const recording of [new Uint8Array(), wav().subarray(0, 43), wav().subarray(0, 100), wav(16_000, 1600.5),
    new TextEncoder().encode(JSON.stringify({ history: [{ role: "assistant", content: "録音ではない入力" }] }))])
    assert.throws(() => validateRecording(recording), publicError("INVALID_AUDIO", 400));
});

test("録音受付はレート・録音時間・総バイト数の上限をヘッダー偽装で迂回させない", () => {
  for (const recording of [wav(7_999), wav(48_001), wav(16_000, 16_000 * .15 - 1),
    wav(16_000, 16_000 * VOICE_MAX_SECONDS + 1), wav(48_000, 48_000 * VOICE_MAX_SECONDS + 1),
    new Uint8Array(VOICE_MAX_WAV_BYTES + 1)])
    assert.throws(() => validateRecording(recording), publicError("INVALID_AUDIO", 400));
});

test("録音bodyはWAVヘッダーが細切れでも全サンプルを順番通りに復元する", async () => {
  const recording = wav(); recording[44] = 131; recording[recording.length - 1] = 255;
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === recording.length) { controller.close(); return; }
    const end = Math.min(recording.length, offset < 44 ? offset + 3 : offset + 701);
    controller.enqueue(recording.slice(offset, end)); offset = end;
  } });
  assert.deepEqual(await readRecording(request(body, { "Content-Type": "audio/wav; codecs=pcm" }), signal()), recording);
  assert.equal(body.locked, false);
});

test("録音bodyは形式違い・body欠如・過大なContent-Lengthを公開エラーで拒否する", async () => {
  const invalidHeaders: Record<string, string>[] = [{}, { "Content-Type": "application/json" }, { "Content-Type": "audio/mpeg" }];
  for (const headers of invalidHeaders)
    await assert.rejects(readRecording(request(wav(), headers), signal()), publicError("INVALID_AUDIO", 400));
  await assert.rejects(readRecording(request(null), signal()), publicError("INVALID_AUDIO", 400));
  await assert.rejects(readRecording(request(wav(), { "Content-Type": "audio/wav", "Content-Length": String(VOICE_MAX_WAV_BYTES + 1) }), signal()), publicError("AUDIO_TOO_LARGE", 413));
});

test("録音bodyはContent-Lengthが欠落・過少でも実受信量で止め、残りをキャンセルする", async () => {
  for (const declared of [undefined, "44"]) {
    let canceled = false, chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { chunks++; controller.enqueue(new Uint8Array(1_000_000)); },
      cancel() { canceled = true; }
    });
    const headers: Record<string, string> = { "Content-Type": "audio/wav" };
    if (declared) headers["Content-Length"] = declared;
    await assert.rejects(readRecording(request(body, headers), signal()), publicError("AUDIO_TOO_LARGE", 413));
    assert.ok(chunks < 10, "無制限にbodyを読み続けないこと");
    assert.equal(canceled, true);
    assert.equal(body.locked, false);
  }
});

test("録音bodyは開始前のキャンセルで読み進めずreaderを解放する", async () => {
  const controller = new AbortController(); controller.abort();
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { canceled = true; } });
  await assert.rejects(readRecording(request(body), controller.signal), { name: "AbortError" });
  assert.equal(canceled, true);
  assert.equal(body.locked, false);
});

test("録音bodyのread待機中でもキャンセルで直ちに終了しreaderを解放する", { timeout: 1500 }, async () => {
  const controller = new AbortController();
  let canceled = false, started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const body = new ReadableStream<Uint8Array>({
    pull() { started(); return new Promise<void>(() => {}); },
    cancel() { canceled = true; }
  });
  const rejected = assert.rejects(readRecording(request(body), controller.signal), { name: "AbortError" });
  await reading; controller.abort();
  await rejected;
  assert.equal(canceled, true);
  assert.equal(body.locked, false);
});
