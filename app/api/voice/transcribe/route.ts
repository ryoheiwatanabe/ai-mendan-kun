import { checkOrigin, PublicError } from "../../../../lib/security/request.ts";
import { readRecording } from "../../../../lib/voice/request.ts";
import { consumeVoiceLimit, createSpeechProvider, getVoiceBindings, voiceError, voiceHeaders } from "../../../../lib/voice/runtime.ts";
import { recordAnswerDiagnostic } from "../../../../lib/answer/diagnostics.ts";
import { getContentExclusions } from "../../../../lib/security/content-exclusions.ts";
import { KnowledgeRepository } from "../../../../lib/knowledge/repository.ts";
import { defaultJevSettings, voiceInputSettings } from "../../../../lib/answer/jev-settings.ts";
import { JevSettingsStore, resolveJevSettings } from "../../../../lib/answer/jev-settings-store.ts";
import { pipelineName } from "../../../../lib/answer/pipeline-config.ts";
import { sttPhrases } from "../../../../lib/voice/input/terms.ts";
import type { Bindings } from "../../../../lib/types.ts";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const env = await getVoiceBindings();
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]);
    const wav = await readRecording(request, signal);
    await consumeVoiceLimit(env, request, "transcribe");
    // 同意済みの公開用語だけを、文字起こしの語彙ヒントにする。全資料・原本・非表示対象は渡さない。
    const vocabulary = await transcriptionVocabulary(env);
    const started = performance.now();
    const result = await createSpeechProvider(env).transcribe(wav, signal, vocabulary.length ? { vocabulary } : undefined);
    recordAnswerDiagnostic({ code: "stt_complete", count: 1, latencyMs: Math.round(performance.now() - started) });
    return Response.json(result, { headers: voiceHeaders });
  } catch (error) {
    // 失敗の分類だけを残す。録音の中身・発言・秘密は記録しない。
    console.info(JSON.stringify({ event: "voice_transcribe_failed", code: failureCode(error) }));
    return voiceError(error);
  }
}

// 公開用語辞書から、認識器へ渡す語だけを取り出す。取得に失敗しても、既定の語彙で文字起こしを続ける。
async function transcriptionVocabulary(env: Bindings): Promise<string[]> {
  // 除外方針の解釈はtryの外で行う。設定不備は呼出側へ伝える（除外なしで続行しない）。
  const policy = getContentExclusions(env);
  try {
    const ownerId = env.OWNER_ID || "default";
    const settings = pipelineName(env) === "jev_v1"
      ? await resolveJevSettings(new JevSettingsStore(env.DB, ownerId), defaultJevSettings(env)) : undefined;
    if (!voiceInputSettings(settings?.settings).sttVocabulary) return [];
    const repository = new KnowledgeRepository(env.DB, ownerId, policy);
    return sttPhrases(await repository.publicTerms());
  } catch { return []; }
}

// 外部由来の文言をそのまま記録しない。既知の形（コードと小さな英数字）のときだけ値を使う。
function failureCode(error: unknown): string {
  if (error instanceof PublicError) return error.code;
  const message = error instanceof Error ? error.message : "";
  return /^[a-z][a-z0-9_]{0,39}$/.test(message) ? message : "unknown";
}
