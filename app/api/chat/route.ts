import { getBindings } from "../../../lib/runtime.ts";
import { createAnswerProvider, createEmbeddingProvider, embeddingSignature, providerSecret } from "../../../lib/ai/providers.ts";
import { assertEmbeddingSignature } from "../../../lib/knowledge/index-config.ts";
import { answer } from "../../../lib/answer/engine.ts";
import { recordAnswerDiagnostic } from "../../../lib/answer/diagnostics.ts";
import { KnowledgeRepository } from "../../../lib/knowledge/repository.ts";
import { checkOrigin, PublicError, readRequest } from "../../../lib/security/request.ts";
import { enforceLimits } from "../../../lib/security/rate-limit.ts";
import type { ChatEvent } from "../../../lib/types.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store, no-transform", "X-Content-Type-Options": "nosniff" };
  try {
    checkOrigin(request);
    const input = await readRequest(request);
    const env = await getBindings();
    const ownerId = env.OWNER_ID || "default";
    const repository = new KnowledgeRepository(env.DB, ownerId);
    if (!await repository.hasKnowledge()) throw new PublicError("NOT_READY", 503, "ただいま面談の準備中です。公開用の情報を確認しています。");
    await assertEmbeddingSignature(env.DB, ownerId, embeddingSignature(env));
    const limited = (value: string | undefined, fallback: number, cap: number) => Math.max(1, Math.min(cap, Number(value) || fallback));
    await enforceLimits(env.DB, { ip: request.headers.get("cf-connecting-ip") || "local", secret: providerSecret(env), ownerId,
      daily: limited(env.DAILY_REQUEST_LIMIT, 100, 100000), hourly: limited(env.IP_HOURLY_LIMIT, 30, 100000) });
    const provider = createAnswerProvider(env), embedding = createEmbeddingProvider(env);
    // TEMP-DIAG: プレビュー限定。数値と固定コードだけを集める。
    const trace: { code: string; count?: number; reason?: string; ids?: string[]; ms?: number }[] = [];
    const collectDiagnostics = (value: unknown) => {
      recordAnswerDiagnostic(value);
      if (!env.DEBUG_TRACE) return;
      const input = value as { code?: string; count?: number; reason?: string; ids?: string[]; latencyMs?: number };
      if (typeof input?.code === "string") trace.push({ code: input.code,
        ...(typeof input.count === "number" ? { count: input.count } : {}),
        ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
        ...(Array.isArray(input.ids) ? { ids: input.ids } : {}),
        ...(typeof input.latencyMs === "number" ? { ms: Math.round(input.latencyMs) } : {}) });
    };
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal, AbortSignal.timeout(90_000)]);
    const iterator = answer(input, { repository, vector: env.VECTORIZE, embedding, provider,
      diagnostics: collectDiagnostics, careerOverview: env.CAREER_OVERVIEW_JSON }, signal);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async pull(output) {
        try {
          const next = await iterator.next();
          if (next.done) {
            // TEMP-DIAG: 拒否の原因（検索か判断か）を見るため、プレビュー限定でコードだけを返す。
            if (env.DEBUG_TRACE && trace.length) output.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "trace", trace })}\n\n`));
            output.close(); return;
          }
          output.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`));
        } catch {
          if (!controller.signal.aborted && !request.signal.aborted) {
            const error: ChatEvent = { type: "error", code: "ANSWER_UNAVAILABLE", message: "回答を続けられませんでした。少し時間をおいて、もう一度お試しください。" };
            output.enqueue(encoder.encode(`data: ${JSON.stringify(error)}\n\n`));
          }
          controller.abort();
          output.close();
        }
      },
      async cancel() { controller.abort(); await iterator.return(undefined); }
    });
    return new Response(stream, { headers: { ...headers, "Content-Type": "text/event-stream; charset=utf-8" } });
  } catch (error) {
    const known = error instanceof PublicError;
    return Response.json({ error: { code: known ? error.code : "SERVICE_UNAVAILABLE", message: known ? error.message : "ただいま接続できません。時間をおいてお試しください。" } }, {
      status: known ? error.status : 503, headers: { ...headers, ...(known && error.status === 429 ? { "Retry-After": "3600" } : {}) }
    });
  }
}
