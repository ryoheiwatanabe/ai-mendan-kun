import test from "node:test";
import assert from "node:assert/strict";
import { consumeVoiceLimit, createSpeechProvider, voiceConfiguration, voiceError } from "../lib/voice/runtime.ts";
import { PublicError } from "../lib/security/request.ts";
import type { Bindings } from "../lib/types.ts";
import { setup } from "./helpers.ts";

const configuration = { VOICE_ENABLED: "true", GEMINI_API_KEY: "test-only-voice-key", ANSWER_PROVIDER: "anthropic",
  EMBEDDING_PROVIDER: "openai", VOICE_DAILY_REQUEST_LIMIT: "4", VOICE_IP_HOURLY_LIMIT: "4" } as Bindings;

test("音声は明示有効化と音声用キーがある場合だけ使える", () => {
  for (const env of [{}, { ...configuration, VOICE_ENABLED: "false" }, { ...configuration, GEMINI_API_KEY: undefined }])
    assert.throws(() => createSpeechProvider(env as Bindings), (error: unknown) => error instanceof PublicError && error.code === "VOICE_NOT_CONFIGURED");
  const provider = createSpeechProvider(configuration);
  assert.equal(provider.sttModel, "gemini-3.5-transcribe");
  assert.equal(provider.ttsModel, "gemini-3.1-flash-tts-preview");
});

test("回答・検索にGoogleを使わなくても、音声の送信先を案内へ含める", () => {
  const result = voiceConfiguration(configuration);
  assert.equal(result.processors, "AnthropicのClaude API・OpenAI API・GoogleのGemini API");
  assert.equal(result.voiceName, "Kore（標準合成声）");
  assert.equal(JSON.stringify(result).includes("test-only-voice-key"), false);
  assert.equal(voiceConfiguration({ ...configuration, ANSWER_PROVIDER: "gemini", EMBEDDING_PROVIDER: "gemini" }).processors, "GoogleのGemini API");
});

test("音声認識と音声回答を同じ回数制限で消費し、上限を超える処理を拒否する", async t => {
  const { db } = await setup(); t.after(() => db.close());
  const env = { ...configuration, DB: db, OWNER_ID: "voice-limit-test" };
  for (const path of ["transcribe", "chat", "transcribe", "chat"])
    await consumeVoiceLimit(env, new Request(`https://example.test/api/voice/${path}`));
  await assert.rejects(consumeVoiceLimit(env, new Request("https://example.test/api/voice/transcribe")),
    (error: unknown) => error instanceof PublicError && error.status === 429);
  const rows = await db.prepare("SELECT bucket,count FROM request_counters").all<{ bucket: string; count: number }>();
  assert.ok(rows.results.every(row => row.bucket.startsWith("voice-limit-test:voice:") && row.count === 4));
});

test("音声エラーはAPIの内部情報を返さず、回数制限だけを安全に案内する", async () => {
  const failure = voiceError(new Error("test-only-upstream-private-detail"));
  assert.equal(failure.status, 503);
  assert.equal(failure.headers.get("Cache-Control"), "no-store, no-transform");
  assert.equal((await failure.text()).includes("test-only-upstream-private-detail"), false);
  const limited = voiceError(new PublicError("RATE_LIMITED", 429, "しばらく待ってください。"));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "3600");
});
