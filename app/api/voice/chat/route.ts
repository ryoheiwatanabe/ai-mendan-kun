import { createAnswerMetrics } from "../../../../lib/answer/metrics.ts";
import type { ChatRequest, Diagnostic } from "../../../../lib/types.ts";
import { createAnswerProvider, createEmbeddingProvider, embeddingSignature, providerSecret } from "../../../../lib/ai/providers.ts";
import { assertEmbeddingSignature } from "../../../../lib/knowledge/index-config.ts";
import { KnowledgeRepository } from "../../../../lib/knowledge/repository.ts";
import { getContentExclusions } from "../../../../lib/security/content-exclusions.ts";
import { checkOrigin, PublicError, readRequest } from "../../../../lib/security/request.ts";
import { enforceLimits } from "../../../../lib/security/rate-limit.ts";
import { voiceAnswer } from "../../../../lib/voice/answer.ts";
import { recordAnswerDiagnostic } from "../../../../lib/answer/diagnostics.ts";
import { consumeVoiceLimit, createSpeechProvider, getVoiceBindings, limit, speaks, voiceError, voiceHeaders } from "../../../../lib/voice/runtime.ts";
import type { VoiceEvent } from "../../../../lib/voice/types.ts";
import { createJevPipeline, pipelineName } from "../../../../lib/answer/pipeline-config.ts";
import { defaultJevSettings, voiceInputSettings } from "../../../../lib/answer/jev-settings.ts";
import { JevSettingsStore, recordStageTiming, resolveJevSettings } from "../../../../lib/answer/jev-settings-store.ts";
import { inputNormalizationJudge } from "../../../../lib/ai/jev-input.ts";
import { normalizeVoiceInput } from "../../../../lib/voice/input/normalize.ts";
import { dictionaryRevision, emptyTermDictionary, type TermDictionary } from "../../../../lib/voice/input/terms.ts";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const env = await getVoiceBindings(), input = await readRequest(request);
    const ownerId = env.OWNER_ID || "default";
    // 非表示対象の方針は、回答・辞書・補正候補のすべてで同じ版を使う。
    const exclusions = getContentExclusions(env);
    const repository = new KnowledgeRepository(env.DB, ownerId, exclusions);
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
    const pipeline = createJevPipeline(env, jevSettings?.settings, collectDiagnostics);
    const voiceInput = voiceInputSettings(jevSettings?.settings);
    // 正規化と回答で、同じ時間の枠を分け合う。入口の外へ別枠を作らない。
    const answerBudget = pipeline?.timeoutMs ?? 90_000;
    // 入力の正規化。原文は変えず、有効な質問と、そこで起きた変更だけを決める。
    const dictionary = voiceInput.enabled && voiceInput.dictionary
      ? await publicTermDictionary(repository, exclusions.revision) : emptyTermDictionary;
    const envelope = await normalizeVoiceInput({ text: input.message, origin: voiceOrigin(input), alternatives: input.alternatives ?? [] },
      { policy: exclusions, dictionary, judge: voiceInput.enabled ? inputNormalizationJudge(pipeline?.judge) : undefined,
        diagnostics: collectDiagnostics, history: input.history,
        thresholds: { meaning: voiceInput.meaningThreshold, confidence: voiceInput.confidenceThreshold },
        timeoutMs: voiceInput.timeoutMs, remainingMs: answerBudget - (performance.now() - started),
        // 最終点検の1段を残せる段数があるときだけ、補正JEVを始める。
        stagesRemaining: pipeline?.settings.limits.maxSerialStages ?? 0,
        // 保存設定のjevMs分と、最終生成の既存の予備を残してから、補正JEVを始める。
        reserveMs: (jevSettings?.settings.budgets.jevMs ?? 4_000) + 2_000 }, signal);
    const encoder = new TextEncoder();
    // 重大な曖昧さでは回答を始めない。理解した質問と確認の案内だけを返し、入力欄での修正に委ねる。
    if (envelope.confirm || !envelope.question) {
      const event: VoiceEvent = { type: "input-normalized", question: envelope.displayQuestion, resolution: envelope.resolution,
        edited: envelope.edited, blocked: envelope.blocked, confirm: true,
        raw: envelope.blocked ? "" : envelope.rawTranscript, notice: envelope.notice };
      const confirmStream = new ReadableStream<Uint8Array>({
        start(output) { output.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); output.close(); }
      });
      return new Response(confirmStream, { headers: { ...voiceHeaders, "Content-Type": "text/event-stream; charset=utf-8" } });
    }
    // 補正に使った段数を回答側の台帳の初期消費にし、時間は回答の予算から差し引く。
    const jev = pipeline && envelope.jevStages ? { ...pipeline, initialStagesUsed: envelope.jevStages } : pipeline;
    // 正規化で時間を使い切ったときも、新しい本体は始めない。既存の時間切れと同じ案内にする。
    const remainingMs = Math.round(answerBudget - (performance.now() - started));
    if (remainingMs <= 0) {
      const seen: VoiceEvent = { type: "input-normalized", question: envelope.displayQuestion, resolution: envelope.resolution,
        edited: envelope.edited, blocked: envelope.blocked, confirm: false, raw: envelope.blocked ? "" : envelope.rawTranscript };
      const slow = new ReadableStream<Uint8Array>({ start(output) {
        output.enqueue(encoder.encode(`data: ${JSON.stringify(seen)}\n\n`));
        output.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", code: "ANSWER_TIME_SHORT",
          message: "時間内に回答をまとめられませんでした。少し時間をおいて、もう一度お試しください。" })}\n\n`));
        output.close();
      } });
      return new Response(slow, { headers: { ...voiceHeaders, "Content-Type": "text/event-stream; charset=utf-8" } });
    }
    const iterator = voiceAnswer({ ...input, message: envelope.effectiveQuestion }, { repository, vector: env.VECTORIZE,
      embedding: createEmbeddingProvider(env), provider: createAnswerProvider(env), speech: createSpeechProvider(env),
      diagnostics: collectDiagnostics, jev, inputEnvelope: envelope,
      // 受付からの経過を全部差し引く。超過しても min 1000ms で延長しない。
      // 受付からの経過を全部差し引いた残りを、本体の予算として渡す。
      timeBudgetMs: remainingMs,
      // 読み上げはサーバー設定が有効で、リクエストが明示的に止めていないときだけ行う。
      careerOverview: env.CAREER_OVERVIEW_JSON, speak: speaks(env) && input.speak !== false }, signal);
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

// 公開用語辞書。現行の公開分だけを、除外方針の版と組にして返す。保存はしない（撤回後の名称を配り続けない）。
async function publicTermDictionary(repository: KnowledgeRepository, policyRevision: string): Promise<TermDictionary> {
  try {
    const terms = await repository.publicTerms();
    return { revision: dictionaryRevision(terms, policyRevision), terms };
  } catch {
    // 辞書が取れなくても、軽い整形だけで続行する。
    return emptyTermDictionary;
  }
}

// 音声／手入力の区別は、権限ではなく処理の選択のヒントとして使う（形はreadRequestで検査済み）。
function voiceOrigin(input: ChatRequest): "voice" | "manual" {
  return input.inputOrigin === "manual" ? "manual" : "voice";
}
