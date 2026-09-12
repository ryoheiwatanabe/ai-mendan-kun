import type { Bindings } from "../types.ts";
import { getBindings } from "../runtime.ts";
import { processorNames } from "../ai/providers.ts";
import { PublicError } from "../security/request.ts";
import { enforceLimits } from "../security/rate-limit.ts";
import { GeminiSpeechProvider } from "./gemini.ts";
import { VOICE_MAX_SECONDS, VOICE_MAX_WAV_BYTES, type VoiceConfiguration } from "./types.ts";

export function createSpeechProvider(env: Bindings): GeminiSpeechProvider {
  const ttsMode = env.VOICE_TTS_MODE === undefined ? "buffered" : env.VOICE_TTS_MODE;
  if (env.VOICE_ENABLED !== "true" || !env.GEMINI_API_KEY || ttsMode !== "buffered" && ttsMode !== "streaming")
    throw new PublicError("VOICE_NOT_CONFIGURED", 503, "音声面談はただいま準備中です。文字面談をご利用ください。");
  return new GeminiSpeechProvider(env.GEMINI_API_KEY, { sttModel: env.VOICE_STT_MODEL, ttsModel: env.VOICE_TTS_MODEL, voice: env.VOICE_NAME, ttsMode });
}

export async function getVoiceBindings(): Promise<Bindings> {
  const env = await getBindings();
  createSpeechProvider(env);
  return env;
}

export async function getVoiceConfiguration(): Promise<VoiceConfiguration> {
  const disabled: VoiceConfiguration = { enabled: false, processors: "", speechProvider: "GoogleのGemini API", voiceName: "Kore（標準合成声）",
    maxRecordingSeconds: VOICE_MAX_SECONDS, maxAudioBytes: VOICE_MAX_WAV_BYTES };
  try {
    return voiceConfiguration(await getVoiceBindings());
  } catch { return disabled; }
}

export function voiceConfiguration(env: Bindings): VoiceConfiguration {
  createSpeechProvider(env);
  const processors = [...processorNames(env).split("・"), "GoogleのGemini API"];
  return { enabled: true, processors: [...new Set(processors)].join("・"), speechProvider: "GoogleのGemini API",
    voiceName: `${env.VOICE_NAME || "Kore"}（標準合成声）`, maxRecordingSeconds: VOICE_MAX_SECONDS, maxAudioBytes: VOICE_MAX_WAV_BYTES };
}

export function limit(value: string | undefined, fallback: number, cap: number): number {
  return Math.max(1, Math.min(cap, Math.floor(Number(value) || fallback)));
}

export async function consumeVoiceLimit(env: Bindings, request: Request): Promise<void> {
  await enforceLimits(env.DB, { ip: request.headers.get("cf-connecting-ip") || "local", secret: env.GEMINI_API_KEY!,
    ownerId: `${env.OWNER_ID || "default"}:voice`, daily: limit(env.VOICE_DAILY_REQUEST_LIMIT, 40, 100),
    hourly: limit(env.VOICE_IP_HOURLY_LIMIT, 10, 30) });
}

export const voiceHeaders = { "Cache-Control": "no-store, no-transform", "X-Content-Type-Options": "nosniff" };
export function voiceError(error: unknown): Response {
  const known = error instanceof PublicError;
  return Response.json({ error: { code: known ? error.code : "VOICE_UNAVAILABLE", message: known ? error.message : "音声の処理を続けられませんでした。もう一度お試しください。" } }, {
    status: known ? error.status : 503, headers: { ...voiceHeaders, ...(known && error.status === 429 ? { "Retry-After": "3600" } : {}) }
  });
}
