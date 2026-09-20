import type { Bindings } from "../types.ts";
import { getBindings } from "../runtime.ts";
import { processorNames } from "../ai/providers.ts";
import { PublicError } from "../security/request.ts";
import { enforceLimits } from "../security/rate-limit.ts";
import { GeminiSpeechProvider } from "./gemini.ts";
import { VOICE_MAX_SECONDS, VOICE_MAX_WAV_BYTES, type VoiceConfiguration } from "./types.ts";
import { getContentExclusions } from "../security/content-exclusions.ts";
import { KnowledgeRepository } from "../knowledge/repository.ts";
import { sttPhrases } from "./input/terms.ts";
import { defaultJevSettings, voiceInputSettings } from "../answer/jev-settings.ts";
import { JevSettingsStore, resolveJevSettings } from "../answer/jev-settings-store.ts";
import { pipelineName } from "../answer/pipeline-config.ts";

export function createSpeechProvider(env: Bindings): GeminiSpeechProvider {
  const ttsMode = env.VOICE_TTS_MODE === undefined ? "buffered" : env.VOICE_TTS_MODE;
  // offは発話を生成しない。音声認識のためにキーは引き続き必要。
  if (env.VOICE_ENABLED !== "true" || !env.GEMINI_API_KEY || ttsMode !== "buffered" && ttsMode !== "streaming" && ttsMode !== "off")
    throw new PublicError("VOICE_NOT_CONFIGURED", 503, "音声面談はただいま準備中です。文字面談をご利用ください。");
  // offのときは合成を呼ばないため、providerのttsModeはbufferedで作る。
  return new GeminiSpeechProvider(env.GEMINI_API_KEY, { sttModel: env.VOICE_STT_MODEL, ttsModel: env.VOICE_TTS_MODEL, voice: env.VOICE_NAME,
    ttsMode: ttsMode === "streaming" ? "streaming" : "buffered" });
}

// 発話を行うか。offのときは合成を呼ばず、テキストだけを返す。
export function speaks(env: Bindings): boolean {
  return env.VOICE_TTS_MODE !== "off";
}

export async function getVoiceBindings(): Promise<Bindings> {
  const env = await getBindings();
  createSpeechProvider(env);
  return env;
}

export async function getVoiceConfiguration(): Promise<VoiceConfiguration> {
  const disabled: VoiceConfiguration = { enabled: false, speak: false, processors: "", speechProvider: "GoogleのGemini API", voiceName: "Kore（標準合成声）",
    maxRecordingSeconds: VOICE_MAX_SECONDS, maxAudioBytes: VOICE_MAX_WAV_BYTES, playbackRate: 1 };
  let env: Bindings;
  try { env = await getVoiceBindings(); voiceConfiguration(env); }
  catch { return disabled; }
  // 除外方針の解釈はtryの外で行う。設定不備を「除外なし」として黙って続行しない。
  const policy = getContentExclusions(env);
  const config = voiceConfiguration(env);
  // 認識の語彙ブーストに使う公開承認済みの名称だけを渡す。設定がOFFなら渡さない。
  const ownerId = env.OWNER_ID || "default";
  const settings = pipelineName(env) === "jev_v1"
    ? await resolveJevSettings(new JevSettingsStore(env.DB, ownerId), defaultJevSettings(env)) : undefined;
  if (!voiceInputSettings(settings?.settings).sttVocabulary) return config;
  // 辞書の取得に失敗しても、語彙なしで続行する。
  const terms = await new KnowledgeRepository(env.DB, ownerId, policy).publicTerms().catch(() => []);
  return { ...config, phrases: sttPhrases(terms) };
}

export function voiceConfiguration(env: Bindings): VoiceConfiguration {
  createSpeechProvider(env);
  const processors = [...processorNames(env).split("・"), "GoogleのGemini API"];
  return { enabled: true, processors: [...new Set(processors)].join("・"), speechProvider: "GoogleのGemini API",
    speak: speaks(env),
    voiceName: `${env.VOICE_NAME || "Kore"}（標準合成声）`, maxRecordingSeconds: VOICE_MAX_SECONDS, maxAudioBytes: VOICE_MAX_WAV_BYTES,
    playbackRate: playbackRate(env.VOICE_PLAYBACK_RATE) };
}

// 読み上げ速度。未指定は1（標準）。極端な値は受け付けない。
export function playbackRate(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.round(Math.max(0.75, Math.min(1.5, parsed)) * 100) / 100;
}

export function limit(value: string | undefined, fallback: number, cap: number): number {
  return Math.max(1, Math.min(cap, Math.floor(Number(value) || fallback)));
}

export async function consumeVoiceLimit(env: Bindings, request: Request, operation: "transcribe" | "chat"): Promise<void> {
  await enforceLimits(env.DB, { ip: request.headers.get("cf-connecting-ip") || "local", secret: env.GEMINI_API_KEY!,
    ownerId: `${env.OWNER_ID || "default"}:voice:${operation}`, daily: limit(env.VOICE_DAILY_REQUEST_LIMIT, 40, 100000),
    hourly: limit(env.VOICE_IP_HOURLY_LIMIT, 10, 100000) });
}

export const voiceHeaders = { "Cache-Control": "no-store, no-transform", "X-Content-Type-Options": "nosniff" };
export function voiceError(error: unknown): Response {
  const known = error instanceof PublicError;
  return Response.json({ error: { code: known ? error.code : "VOICE_UNAVAILABLE", message: known ? error.message : "音声の処理を続けられませんでした。もう一度お試しください。" } }, {
    status: known ? error.status : 503, headers: { ...voiceHeaders, ...(known && error.status === 429 ? { "Retry-After": "3600" } : {}) }
  });
}
