import type { AnswerProvider, EmbeddingProvider, ModelPayload } from "../types.ts";
import { parseSegment, parsePayload } from "../answer/guard.ts";
import { completedSegments, readSse } from "./sse.ts";
import { answerSchema, verifySchema, instructions, modelConversation } from "./prompt.ts";
import { parseVerification } from "./verification.ts";

// Geminiの構造化出力ではネストした制約の組合せが拒否される場合がある。
// 件数・本文長・引用長は共通parse/guardで検証する。
const geminiAnswerSchema = JSON.parse(JSON.stringify(answerSchema, (key, value) =>
  ["minLength", "maxLength", "minItems", "maxItems"].includes(key) ? undefined : value));

const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/";
async function errorCategory(response: Response) {
  let body: any;
  try { body = await response.json(); } catch { return ""; }
  const allowed = new Set(["INVALID_ARGUMENT", "PERMISSION_DENIED", "NOT_FOUND", "RESOURCE_EXHAUSTED", "UNAUTHENTICATED", "API_KEY_INVALID", "API_KEY_SERVICE_BLOCKED", "SERVICE_DISABLED", "BILLING_DISABLED"]);
  const details = Array.isArray(body?.error?.details) ? body.error.details : [];
  const categories = new Set<string>([body?.error?.status, ...details.map((item: any) => item?.reason)].filter(value => allowed.has(value)));
  for (const detail of details) {
    if (detail?.metadata?.quota_limit_value === "0") categories.add("QUOTA_ZERO");
    if (detail?.["@type"] !== "type.googleapis.com/google.rpc.QuotaFailure" || !Array.isArray(detail.violations)) continue;
    for (const violation of detail.violations) {
      if (violation?.quotaValue === "0" || violation?.quotaValue === 0) categories.add("QUOTA_ZERO");
      const quotaId = typeof violation?.quotaId === "string" ? violation.quotaId : "";
      if (quotaId.endsWith("-FreeTier")) categories.add("QUOTA_FREE_TIER");
      if (quotaId.includes("PerDay")) categories.add("QUOTA_DAILY");
    }
  }
  return [...categories].map(value => `_${value}`).join("");
}

export class GeminiProvider implements AnswerProvider, EmbeddingProvider {
  private readonly key: string;
  readonly model: string;
  readonly embeddingModel: string;
  readonly dimensions: number;
  constructor(key: string, model = "gemini-3.8-flash", embeddingModel = "gemini-embedding-2", dimensions = 1536) {
    this.key = key; this.model = model; this.embeddingModel = embeddingModel; this.dimensions = dimensions;
  }

  async embed(text: string, signal?: AbortSignal, purpose: "query" | "document" = "query"): Promise<number[]> {
    const firstGeneration = this.embeddingModel === "gemini-embedding-001";
    const formatted = firstGeneration ? text : purpose === "document" ? `title: none | text: ${text}` : `task: question answering | query: ${text}`;
    const response = await fetch(`${endpoint}${encodeURIComponent(this.embeddingModel)}:embedContent`, {
      method: "POST", headers: { "x-goog-api-key": this.key, "Content-Type": "application/json" },
      body: JSON.stringify({ content: { parts: [{ text: formatted }] }, outputDimensionality: this.dimensions,
        ...(firstGeneration ? { taskType: purpose === "document" ? "RETRIEVAL_DOCUMENT" : "QUESTION_ANSWERING" } : {}) }),
      signal, redirect: "manual"
    });
    if (!response.ok) throw new Error(`embedding_http_${response.status}${await errorCategory(response)}`);
    const body = await response.json() as { embedding?: { values: number[] } };
    const vector = body.embedding?.values;
    if (!Array.isArray(vector) || vector.length !== this.dimensions || vector.some(value => typeof value !== "number" || !Number.isFinite(value))) throw new Error("invalid_embedding");
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(norm) || norm === 0) throw new Error("invalid_embedding");
    return vector.map(value => value / norm);
  }

  async checkModels(signal: AbortSignal) {
    const results = [];
    for (const model of [this.model, this.embeddingModel]) {
      const response = await fetch(`${endpoint}${encodeURIComponent(model)}`, { headers: { "x-goog-api-key": this.key }, signal, redirect: "manual" });
      const category = response.ok ? "" : await errorCategory(response);
      if (response.ok) await response.body?.cancel();
      results.push({ model, httpStatus: response.status, category });
    }
    return results;
  }

  async *stream(input: Parameters<AnswerProvider["stream"]>[0], signal: AbortSignal): ReturnType<AnswerProvider["stream"]> {
    const purpose = input.purpose ?? "answer";
    const verifying = purpose === "verify";
    const userParts: Record<string, unknown> = modelConversation(input.question, input.history, input.evidence);
    if (input.candidate) userParts.candidate = input.candidate;
    if (input.repair) userParts.repair = input.repair;
    if (input.lengthBudget) userParts.lengthBudget = { mode: input.lengthBudget.mode, max: input.lengthBudget.max, target: input.lengthBudget.target };
    userParts.purpose = purpose;
    // verifyは{accepted,reason}だけを要求する。answer schemaは変更しない。
    // Geminiの構造化出力ではネスト制約が拒否される場合があるため、検証ではenumのみの短いschemaを使う。
    const responseSchema = verifying ? verifySchema : geminiAnswerSchema;
    // 校閲の出力は短い判定JSONだが、内部推論も収まるよう生成と同じ上限を保つ。
    const maxOutputTokens = 4096;
    const response = await fetch(`${endpoint}${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`, {
      method: "POST", headers: { "x-goog-api-key": this.key, "Content-Type": "application/json" },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: instructions(purpose) }] },
        contents: [{ role: "user", parts: [{ text: JSON.stringify(userParts) }] }],
        generationConfig: { responseMimeType: "application/json", responseJsonSchema: responseSchema,
          maxOutputTokens, candidateCount: 1,
          thinkingConfig: this.model.startsWith("gemini-3") ? { thinkingLevel: "LOW", includeThoughts: false } : { thinkingBudget: 512, includeThoughts: false } }
      }), signal, redirect: "manual"
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`answer_http_${response.status}`); }
    let json = "", emitted = 0, finished = false;
    let usage: { input: number; output: number } | undefined;
    for await (const raw of readSse(response.body, signal)) {
      const event = JSON.parse(raw);
      if (event.error) throw new Error("provider_stream_error");
      if (event.promptFeedback?.blockReason) throw new Error("provider_refusal");
      const candidate = event.candidates?.[0];
      if (candidate?.finishReason === "STOP") finished = true;
      else if (candidate?.finishReason) throw new Error("provider_incomplete");
      if (event.usageMetadata) usage = { input: event.usageMetadata.promptTokenCount ?? 0,
        output: (event.usageMetadata.candidatesTokenCount ?? 0) + (event.usageMetadata.thoughtsTokenCount ?? 0) };
      for (const part of candidate?.content?.parts ?? []) {
        if (part.thought) continue;
        if (typeof part.text === "string") json += part.text;
      }
      if (json.length > 24_000) throw new Error("answer_too_large");
      // verifyはaccepted/reasonのみを返すためincremental segmentは生成しない。answerのみsegmentsを扱う。
      if (!verifying) {
        const segments = completedSegments(json);
        if (segments.length > 4) throw new Error("too_many_segments");
        while (emitted < segments.length) yield { type: "segment", segment: parseSegment(segments[emitted++]) };
      }
    }
    if (!finished) throw new Error("provider_incomplete");
    if (verifying) {
      // verifierは完全なcandidateを受け取り、書き換えずに合格/不合格のみを返す。
      const outcome = parseVerification(JSON.parse(json), input.candidate);
      yield { type: "complete", payload: outcome.payload ?? { segments: [], answerability: "unknown", confidence: "low" }, usage,
        verification: { accepted: outcome.accepted, reason: outcome.reason } };
      return;
    }
    const parsed = parsePayloadJson(json);
    if (parsed.segments.length !== emitted) throw new Error("invalid_model_payload");
    yield { type: "complete", payload: parsed, usage };
  }
}

function parsePayloadJson(json: string): ModelPayload {
  return parsePayload(JSON.parse(json));
}
