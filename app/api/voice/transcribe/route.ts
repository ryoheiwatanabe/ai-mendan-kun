import { checkOrigin, PublicError } from "../../../../lib/security/request.ts";
import { readRecording } from "../../../../lib/voice/request.ts";
import { consumeVoiceLimit, createSpeechProvider, getVoiceBindings, voiceError, voiceHeaders } from "../../../../lib/voice/runtime.ts";
import { recordAnswerDiagnostic } from "../../../../lib/answer/diagnostics.ts";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const env = await getVoiceBindings();
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]);
    const wav = await readRecording(request, signal);
    await consumeVoiceLimit(env, request, "transcribe");
    const started = performance.now();
    const result = await createSpeechProvider(env).transcribe(wav, signal);
    recordAnswerDiagnostic({ code: "stt_complete", count: 1, latencyMs: Math.round(performance.now() - started) });
    return Response.json(result, { headers: voiceHeaders });
  } catch (error) {
    // 失敗の分類だけを残す。録音の中身・発言・秘密は記録しない。
    console.info(JSON.stringify({ event: "voice_transcribe_failed", code: failureCode(error) }));
    return voiceError(error);
  }
}

// 外部由来の文言をそのまま記録しない。既知の形（コードと小さな英数字）のときだけ値を使う。
function failureCode(error: unknown): string {
  if (error instanceof PublicError) return error.code;
  const message = error instanceof Error ? error.message : "";
  return /^[a-z][a-z0-9_]{0,39}$/.test(message) ? message : "unknown";
}
