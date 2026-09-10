import { createAnswerProvider, createEmbeddingProvider, embeddingSignature, providerSecret } from "../../../../lib/ai/providers.ts";
import { assertEmbeddingSignature } from "../../../../lib/knowledge/index-config.ts";
import { KnowledgeRepository } from "../../../../lib/knowledge/repository.ts";
import { checkOrigin, PublicError, readRequest } from "../../../../lib/security/request.ts";
import { enforceLimits } from "../../../../lib/security/rate-limit.ts";
import { voiceAnswer } from "../../../../lib/voice/answer.ts";
import { consumeVoiceLimit, createSpeechProvider, getVoiceBindings, limit, voiceError, voiceHeaders } from "../../../../lib/voice/runtime.ts";
import type { VoiceEvent } from "../../../../lib/voice/types.ts";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const env = await getVoiceBindings(), input = await readRequest(request);
    const ownerId = env.OWNER_ID || "default", repository = new KnowledgeRepository(env.DB, ownerId);
    if (!await repository.hasKnowledge()) throw new PublicError("NOT_READY", 503, "公開用の情報を確認しています。少し時間をおいてお試しください。");
    await assertEmbeddingSignature(env.DB, ownerId, embeddingSignature(env));
    await consumeVoiceLimit(env, request);
    await enforceLimits(env.DB, { ip: request.headers.get("cf-connecting-ip") || "local", secret: providerSecret(env), ownerId,
      daily: limit(env.DAILY_REQUEST_LIMIT, 100, 1000), hourly: limit(env.IP_HOURLY_LIMIT, 30, 100) });
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal, AbortSignal.timeout(180_000)]);
    const iterator = voiceAnswer(input, { repository, vector: env.VECTORIZE, embedding: createEmbeddingProvider(env),
      provider: createAnswerProvider(env), speech: createSpeechProvider(env) }, signal);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async pull(output) {
        try {
          const next = await iterator.next();
          if (next.done) { output.close(); return; }
          output.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`));
        } catch (failure) {
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
