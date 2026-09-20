import { createAnswerMetrics } from "../../../../lib/answer/metrics.ts";
import type { Diagnostic } from "../../../../lib/types.ts";
import { createAnswerProvider, createEmbeddingProvider, embeddingSignature, providerSecret } from "../../../../lib/ai/providers.ts";
import { assertEmbeddingSignature } from "../../../../lib/knowledge/index-config.ts";
import { KnowledgeRepository } from "../../../../lib/knowledge/repository.ts";
import { checkOrigin, PublicError, readRequest } from "../../../../lib/security/request.ts";
import { enforceLimits } from "../../../../lib/security/rate-limit.ts";
import { voiceAnswer } from "../../../../lib/voice/answer.ts";
import { recordAnswerDiagnostic } from "../../../../lib/answer/diagnostics.ts";
import { consumeVoiceLimit, createSpeechProvider, getVoiceBindings, limit, speaks, voiceError, voiceHeaders } from "../../../../lib/voice/runtime.ts";
import type { VoiceEvent } from "../../../../lib/voice/types.ts";
import { createJevPipeline, pipelineName } from "../../../../lib/answer/pipeline-config.ts";
import { defaultJevSettings } from "../../../../lib/answer/jev-settings.ts";
import { JevSettingsStore, recordStageTiming, resolveJevSettings } from "../../../../lib/answer/jev-settings-store.ts";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const env = await getVoiceBindings(), input = await readRequest(request);
    const ownerId = env.OWNER_ID || "default", repository = new KnowledgeRepository(env.DB, ownerId);
    if (!await repository.hasKnowledge()) throw new PublicError("NOT_READY", 503, "公開用の情報を確認しています。少し時間をおいてお試しください。");
    await assertEmbeddingSignature(env.DB, ownerId, embeddingSignature(env));
    await consumeVoiceLimit(env, request, "chat");
    await enforceLimits(env.DB, { ip: request.headers.get("cf-connecting-ip") || "local", secret: providerSecret(env), ownerId,
      daily: limit(env.DAILY_REQUEST_LIMIT, 100, 100000), hourly: limit(env.IP_HOURLY_LIMIT, 30, 100000) });
    const controller = new AbortController();
    const started = performance.now();
    const signal = AbortSignal.any([request.signal, controller.signal, AbortSignal.timeout(180_000)]);
    // 文字画面と同じ設定を使い、段階ごとの所要時間も同じように残す。
    const metrics = createAnswerMetrics();
    const collectDiagnostics = (value: Diagnostic) => {
      metrics.record(value);
      recordAnswerDiagnostic(value);
      const input = value as { code?: string; latencyMs?: number };
      const stage = input.code === "scope_complete" ? "scope" : input.code === "generation_complete" ? "generation"
        : input.code === "repair_complete" ? "repair" : input.code === "jev_complete" ? "judge"
          : input.code === "screening_complete" ? "screening" : null;
      if (stage && typeof input.latencyMs === "number") void recordStageTiming(env.DB, ownerId, stage, input.latencyMs).catch(() => {});
    };
    // 文字画面と同じ保存設定を使う。質問の開始時点で固定する。
    const jevSettings = pipelineName(env) === "jev_v1"
      ? await resolveJevSettings(new JevSettingsStore(env.DB, ownerId), defaultJevSettings(env)) : undefined;
    if (jevSettings?.fallback) recordAnswerDiagnostic({ code: "jev_settings_fallback", count: 1, reason: jevSettings.fallback });
    const iterator = voiceAnswer(input, { repository, vector: env.VECTORIZE, embedding: createEmbeddingProvider(env),
      provider: createAnswerProvider(env), speech: createSpeechProvider(env), diagnostics: collectDiagnostics,
      jev: createJevPipeline(env, jevSettings?.settings, collectDiagnostics),
      // 読み上げはサーバー設定が有効で、リクエストが明示的に止めていないときだけ行う。
      careerOverview: env.CAREER_OVERVIEW_JSON, speak: speaks(env) && input.speak !== false }, signal);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async pull(output) {
        try {
          const next = await iterator.next();
          if (next.done) { output.close(); return; }
          const event = next.value.type === "done" ? { ...next.value, metrics: metrics.snapshot() } : next.value;
          output.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch (failure) {
          // 音声も、ストリームが例外で終わった理由を残す。時間切れと利用者の中止を分ける。
          recordAnswerDiagnostic({ code: "stream_failure", count: 1, latencyMs: Math.round(performance.now() - started),
            reason: signal.aborted ? "iterator_aborted" : "iterator_threw" });
          if (!controller.signal.aborted && !request.signal.aborted) {
            const limited = failure instanceof Error && ["voice_query_limit", "voice_answer_too_large"].includes(failure.message);
            const error: VoiceEvent = { type: "error", code: limited ? "VOICE_ANSWER_LIMIT" : "VOICE_UNAVAILABLE", message: limited
              ? "回答が長くなったため中断しました。質問を分けてお話しください。"
              : "音声の回答を続けられませんでした。画面の文章を確認し、もう一度お試しください。" };
            output.enqueue(encoder.encode(`data: ${JSON.stringify(error)}\n\n`));
          }
          controller.abort(); output.close();
          await iterator.return(undefined);
        }
      },
      async cancel() { controller.abort(); await iterator.return(undefined); }
    });
    return new Response(stream, { headers: { ...voiceHeaders, "Content-Type": "text/event-stream; charset=utf-8" } });
  } catch (error) { return voiceError(error); }
}
