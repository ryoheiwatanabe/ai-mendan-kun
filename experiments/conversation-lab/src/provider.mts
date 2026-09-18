// 単発生成の呼び出し。段階の時刻とusageだけを返し、本文は記録側へ渡す。
import { readSse } from "../../../lib/ai/sse.ts";
import { answerSchema } from "./lab.mts";
import type { AnswerPayload, CallTiming, CallUsage } from "./types.mts";

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  session: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

export type CallResult =
  | { ok: true; payload: AnswerPayload; timing: CallTiming; usage: CallUsage }
  | { ok: false; errorKind: string; timing: CallTiming; usage: CallUsage };

// 応答コードは固定の識別子へ写像する。応答本文は記録しない。
export function classifyHttp(status: number): string {
  return "http_" + String(status);
}

// 接続先は許可リストのホストだけにする。手入力のURLへ自由に接続しない。
export function assertAllowedHost(baseUrl: string, allowedHosts: string[]): string {
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    throw new Error("invalid_base_url");
  }
  if (!allowedHosts.includes(host)) throw new Error("host_not_allowed: " + host);
  return host;
}

export function parseAnswer(json: string): AnswerPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.answer !== "string") return null;
  if (typeof item.limitations !== "string") return null;
  if (!Array.isArray(item.sourceIds) || item.sourceIds.some(id => typeof id !== "string")) return null;
  return { answer: item.answer, sourceIds: item.sourceIds as string[], limitations: item.limitations };
}

// 画面の中止（クライアントの切断）と、ラボ側のタイムアウトの両方で中断できるようにする。
export async function callAnswer(system: string, user: string, config: ProviderConfig, external?: AbortSignal): Promise<CallResult> {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
  const timing: CallTiming = { apiStartMs: 0, firstTokenMs: null, completeMs: null, totalMs: 0 };
  let usage: CallUsage = { inputTokens: null, outputTokens: null };
  try {
    const response = await fetch(config.baseUrl.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      redirect: "manual",
      headers: {
        Authorization: "Bearer " + config.apiKey,
        "Content-Type": "application/json",
        "x-opencode-session": config.session,
        "User-Agent": "ai-mendan-kun-lab/0.1"
      },
      body: JSON.stringify({
        model: config.model,
        stream: true,
        stream_options: { include_usage: true },
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        response_format: { type: "json_schema", json_schema: { name: "lab_answer", strict: true, schema: answerSchema } }
      }),
      signal
    });
    timing.apiStartMs = Math.round(performance.now() - started);
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      timing.totalMs = Math.round(performance.now() - started);
      return { ok: false, errorKind: classifyHttp(response.status), timing, usage };
    }
    let json = "";
    for await (const raw of readSse(response.body, signal)) {
      if (raw === "[DONE]") break;
      const event = JSON.parse(raw) as {
        choices?: { delta?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      if (event.usage) {
        usage = {
          inputTokens: typeof event.usage.prompt_tokens === "number" ? event.usage.prompt_tokens : null,
          outputTokens: typeof event.usage.completion_tokens === "number" ? event.usage.completion_tokens : null
        };
      }
      const piece = event.choices?.[0]?.delta?.content ?? "";
      if (piece && timing.firstTokenMs === null) timing.firstTokenMs = Math.round(performance.now() - started);
      json += piece;
    }
    timing.completeMs = Math.round(performance.now() - started);
    timing.totalMs = timing.completeMs;
    const payload = parseAnswer(json);
    return payload ? { ok: true, payload, timing, usage } : { ok: false, errorKind: "invalid_payload", timing, usage };
  } catch {
    timing.totalMs = Math.round(performance.now() - started);
    const errorKind = external?.aborted ? "aborted" : controller.signal.aborted ? "timeout" : "network_error";
    return { ok: false, errorKind, timing, usage };
  } finally {
    clearTimeout(timer);
  }
}
