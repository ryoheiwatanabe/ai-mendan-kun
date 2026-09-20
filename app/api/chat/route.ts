import { createAnswerMetrics } from "../../../lib/answer/metrics.ts";
import type { Diagnostic } from "../../../lib/types.ts";
import { getBindings } from "../../../lib/runtime.ts";
import { createAnswerProvider, createEmbeddingProvider, embeddingSignature, providerNames, providerSecret } from "../../../lib/ai/providers.ts";
import { assertEmbeddingSignature } from "../../../lib/knowledge/index-config.ts";
import { answer, TIME_BUDGET_MS } from "../../../lib/answer/engine.ts";
import { promptVersion } from "../../../lib/ai/prompt.ts";
import { contextFields, recordAnswerDiagnostic } from "../../../lib/answer/diagnostics.ts";
import { KnowledgeRepository } from "../../../lib/knowledge/repository.ts";
import { checkOrigin, PublicError, readRequest } from "../../../lib/security/request.ts";
import { enforceLimits } from "../../../lib/security/rate-limit.ts";
import type { AnswerTrace, ChatEvent, DiagnosticCode } from "../../../lib/types.ts";
import { createJevPipeline, pipelineName } from "../../../lib/answer/pipeline-config.ts";
import { compactPromptVersion } from "../../../lib/answer/compact.ts";
import { defaultJevSettings } from "../../../lib/answer/jev-settings.ts";
import { JevSettingsStore, recordScoreSample, recordStageTiming, resolveJevSettings } from "../../../lib/answer/jev-settings-store.ts";

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
    // 質問の開始時点で採点設定を固定する。回答の途中に保存されても、この質問の判定へ混ぜない。
    const jevSettings = pipelineName(env) === "jev_v1"
      ? await resolveJevSettings(new JevSettingsStore(env.DB, ownerId), defaultJevSettings(env)) : undefined;
    // TEMP-DIAG: プレビュー限定。数値と固定コードだけを集める。
    const trace: AnswerTrace[] = [];
    const metrics = createAnswerMetrics();
    const collectDiagnostics = (value: Diagnostic) => {
      metrics.record(value);
      recordAnswerDiagnostic(value);
      if (!env.DEBUG_TRACE) return;
      const input = value as { code?: string; count?: number; reason?: string; ids?: string[]; latencyMs?: number;
        inputTokens?: number; outputTokens?: number; scores?: Record<string, number>; scopeScores?: Record<string, number>;
        confidence?: number; supportStrength?: number };
      const tokens = (item: unknown) => typeof item === "number" && Number.isFinite(item) && item >= 0 ? item : undefined;
      if (typeof input?.code === "string") trace.push({ code: input.code as DiagnosticCode, ...contextFields(value),
        ...(typeof input.count === "number" ? { count: input.count } : {}),
        ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
        ...(Array.isArray(input.ids) ? { ids: input.ids } : {}),
        ...(typeof input.latencyMs === "number" ? { ms: Math.round(input.latencyMs) } : {}),
        ...(tokens(input.inputTokens) !== undefined ? { inputTokens: tokens(input.inputTokens)! } : {}),
        ...(tokens(input.outputTokens) !== undefined ? { outputTokens: tokens(input.outputTokens)! } : {}),
        ...(input.scores ? { scores: input.scores } : {}),
        ...(input.scopeScores ? { scopeScores: input.scopeScores } : {}),
        ...(typeof input.confidence === "number" ? { confidence: input.confidence } : {}),
        ...(typeof input.supportStrength === "number" ? { supportStrength: input.supportStrength } : {}) });
      // 採点の控えを残し、管理画面で新しい設定を当てた採否例を確認できるようにする。本文は残さない。
      const sample = input.scores ? { kind: "answer" as const, scores: input.scores }
        : input.scopeScores ? { kind: "scope" as const, scores: input.scopeScores } : null;
      if (sample) void recordScoreSample(env.DB, ownerId, { createdAt: new Date().toISOString(),
        settingsVersion: jevSettings?.version ?? null, ...sample }).catch(() => {});
      // 段階ごとの所要時間を残し、p50/p95と修復率を管理画面で確認できるようにする。
      const stage = input.code === "scope_complete" ? "scope" : input.code === "generation_complete" ? "generation"
        : input.code === "repair_complete" ? "repair" : input.code === "jev_complete" ? "judge"
          : input.code === "screening_complete" ? "screening" : null;
      if (stage && typeof input.latencyMs === "number") void recordStageTiming(env.DB, ownerId, stage, input.latencyMs).catch(() => {});
    };
    const jev = createJevPipeline(env, jevSettings?.settings, collectDiagnostics);
    const controller = new AbortController();
    const started = performance.now();
    if (jevSettings?.fallback) collectDiagnostics({ code: "jev_settings_fallback", count: 1, reason: jevSettings.fallback });
    // 依頼ごとの固定条件を1件だけ残す。識別子だけで、質問・回答・根拠の本文は含めない。
    // 本番のビルド/デプロイIDはこの経路では取れないため、デプロイ側の記録と突き合わせる。
    collectDiagnostics({ code: "answer_context", count: 1, provider: providerNames(env).answer,
      ...(env.ANSWER_MODEL ? { model: env.ANSWER_MODEL } : {}), promptVersion: jev ? compactPromptVersion : promptVersion, traceId: crypto.randomUUID(),
      ...(jevSettings ? { settingsVersion: String(jevSettings.version ?? 0),
        settingsSource: jevSettings.fallback ? "invalid" : jevSettings.version === null ? "default" : "stored" } : {}) });
    const signal = AbortSignal.any([request.signal, controller.signal, AbortSignal.timeout(jev ? jev.timeoutMs + 2000 : 90_000)]);
    const iterator = answer(input, { repository, vector: env.VECTORIZE, embedding, provider,
      diagnostics: collectDiagnostics, careerOverview: env.CAREER_OVERVIEW_JSON, timeBudgetMs: jev?.timeoutMs ?? TIME_BUDGET_MS, jev }, signal);
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
          const event = next.value.type === "done" ? { ...next.value, metrics: metrics.snapshot() } : next.value;
          output.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // ストリームが例外で終わった場合も、止まった段階を確認できるようにする。
          collectDiagnostics({ code: "stream_failure", count: 1, latencyMs: Math.round(performance.now() - started),
            reason: signal.aborted ? "iterator_aborted" : "iterator_threw" });
          try {
            // TEMP-DIAG: 失敗時もプレビュー限定でコードだけを返す。
            if (env.DEBUG_TRACE && trace.length) output.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "trace", trace })}\n\n`));
            if (!controller.signal.aborted && !request.signal.aborted) {
              const error: ChatEvent = { type: "error", code: "ANSWER_UNAVAILABLE", message: "回答を続けられませんでした。少し時間をおいて、もう一度お試しください。" };
              output.enqueue(encoder.encode(`data: ${JSON.stringify(error)}\n\n`));
            }
          } catch {
            // 画面が既に閉じている場合は送れない。記録だけを残す。
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
