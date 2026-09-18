import type { AnswerProvider, EmbeddingProvider, ModelPayload } from "../types.ts";
import { parseSegment, parsePayload } from "../answer/guard.ts";
import { completedSegments, readSse } from "./sse.ts";
import { answerSchema, verifySchema, instructions, modelConversation } from "./prompt.ts";
import { parseVerification } from "./verification.ts";
import { compactInstructions, compactSchema, compactEvidence, minimalHistory, type CompactInput, type CompactResult } from "../answer/compact.ts";

// OpenAI互換の別サービス（OpenCode Goなど）へ同じ実装を向けるための差分。
// schemaはjson_schema strict、objectはjson_objectのみを指定する。
export type StructuredOutput = "schema" | "object";
export interface OpenAIProviderOptions {
  baseUrl?: string;
  structuredOutput?: StructuredOutput;
  includeStore?: boolean;
  tokenField?: "max_completion_tokens" | "max_tokens";
  // json_objectを要求するサービスは、本文に"json"の語があることを条件にする場合がある。
  systemSuffix?: string;
  // サービス固有の必須ヘッダー（OpenCode Goのx-opencode-sessionなど）。
  headers?: Record<string, string>;
}

export class OpenAIProvider implements AnswerProvider, EmbeddingProvider {
  private readonly key: string;
  private readonly baseUrl: string;
  private readonly structuredOutput: StructuredOutput;
  private readonly includeStore: boolean;
  private readonly tokenField: "max_completion_tokens" | "max_tokens";
  private readonly systemSuffix: string;
  private readonly extraHeaders: Record<string, string>;
  readonly model: string;
  readonly embeddingModel: string;
  readonly dimensions: number;
  constructor(key: string, model = "gpt-4.1-mini", embeddingModel = "text-embedding-3-small", dimensions = 1536,
              options: OpenAIProviderOptions = {}) {
    this.key = key; this.model = model; this.embeddingModel = embeddingModel; this.dimensions = dimensions;
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.structuredOutput = options.structuredOutput ?? "schema";
    this.includeStore = options.includeStore ?? true;
    this.tokenField = options.tokenField ?? "max_completion_tokens";
    this.systemSuffix = options.systemSuffix ?? "";
    this.extraHeaders = options.headers ?? {};
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST", headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.embeddingModel, input: text, dimensions: this.dimensions, encoding_format: "float" }),
      signal, redirect: "manual"
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`embedding_http_${response.status}`); }
    const body = await response.json() as { data?: { embedding: number[] }[] };
    const vector = body.data?.[0]?.embedding;
    if (!vector || vector.length !== this.dimensions || vector.some(value => !Number.isFinite(value))) throw new Error("invalid_embedding");
    return vector;
  }

  async generateCompact(input: CompactInput, signal: AbortSignal): Promise<CompactResult> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST", redirect: "manual", signal,
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json", ...this.extraHeaders },
      body: JSON.stringify({ model: this.model, ...(this.includeStore ? { store: false } : {}), stream: true,
        stream_options: { include_usage: true }, [this.tokenField]: 1024, temperature: 0,
        messages: [{ role: "system", content: compactInstructions + this.systemSuffix }, { role: "user", content: JSON.stringify({
          question: input.question, history: minimalHistory(input.history), evidence: compactEvidence(input.evidence),
          lengthBudget: input.lengthBudget, ...(input.repair ? { repair: input.repair, previous: input.previous } : {})
        }) }],
        response_format: this.structuredOutput === "object" ? { type: "json_object" }
          : { type: "json_schema", json_schema: { name: "compact_answer", strict: true, schema: compactSchema } }
      })
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("compact_provider_error"); }
    let json = "", finished = false;
    let usage: CompactResult["usage"];
    for await (const raw of readSse(response.body, signal)) {
      if (raw === "[DONE]") break;
      const event = JSON.parse(raw);
      const choice = event.choices?.[0];
      if (event.error || choice?.delta?.refusal) throw new Error("compact_provider_error");
      if (choice?.finish_reason === "stop") finished = true;
      else if (choice?.finish_reason) throw new Error("compact_provider_incomplete");
      json += choice?.delta?.content ?? "";
      if (json.length > 12000) throw new Error("invalid_compact_payload");
      if (event.usage) usage = { input: event.usage.prompt_tokens, output: event.usage.completion_tokens };
    }
    signal.throwIfAborted();
    if (!finished) throw new Error("compact_provider_incomplete");
    let candidate: unknown;
    try { candidate = JSON.parse(json); } catch { throw new Error("invalid_compact_payload"); }
    return { candidate, usage };
  }

  async *stream(input: Parameters<AnswerProvider["stream"]>[0], signal: AbortSignal): ReturnType<AnswerProvider["stream"]> {
    const purpose = input.purpose ?? "answer";
    const verifying = purpose === "verify";
    const userPayload: Record<string, unknown> = modelConversation(input.question, input.history, input.evidence);
    if (input.candidate) userPayload.candidate = input.candidate;
    if (input.repair) userPayload.repair = input.repair;
    if (input.lengthBudget) userPayload.lengthBudget = { mode: input.lengthBudget.mode, max: input.lengthBudget.max, target: input.lengthBudget.target };
    userPayload.purpose = purpose;
    // verifyは{accepted,reason}のみ。answer schemaは変更せず、verify時は上限を縮める。
    const responseFormat = this.structuredOutput === "object"
      ? { type: "json_object" }
      : verifying
        ? { type: "json_schema", json_schema: { name: "grounded_verification", strict: true, schema: verifySchema } }
        : { type: "json_schema", json_schema: { name: "grounded_answer", strict: true, schema: answerSchema } };
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json", ...this.extraHeaders },
      body: JSON.stringify({ model: this.model, ...(this.includeStore ? { store: false } : {}), stream: true, stream_options: { include_usage: true },
        [this.tokenField]: verifying ? 1024 : 4096, temperature: 0,
        messages: [{ role: "system", content: instructions(purpose) + this.systemSuffix }, { role: "user", content: JSON.stringify(userPayload) }],
        response_format: responseFormat
      }), signal, redirect: "manual"
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`answer_http_${response.status}`); }
    let json = "", emitted = 0, finished = false;
    let usage: { input: number; output: number } | undefined;
    for await (const raw of readSse(response.body, signal)) {
      if (raw === "[DONE]") break;
      const event = JSON.parse(raw);
      if (event.error) throw new Error("provider_stream_error");
      const choice = event.choices?.[0];
      if (choice?.delta?.refusal) throw new Error("provider_refusal");
      if (choice?.finish_reason === "stop") finished = true;
      else if (choice?.finish_reason) throw new Error("provider_incomplete");
      if (event.usage) usage = { input: event.usage.prompt_tokens, output: event.usage.completion_tokens };
      json += choice?.delta?.content ?? "";
      if (json.length > 24_000) throw new Error("answer_too_large");
      // verifyはincremental completedSegmentsを生成しない(=自然に0件のまま)。
      if (!verifying) {
        const segments = completedSegments(json);
        if (segments.length > 4) throw new Error("too_many_segments");
        while (emitted < segments.length) {
          yield { type: "segment", segment: parseSegment(segments[emitted++]) };
        }
      }
    }
    if (!finished) throw new Error("provider_incomplete");
    if (verifying) {
      // verifier契約: 完全なcandidateを渡し、受け取った判定だけを返す。候補は書き換えない。
      const outcome = parseVerification(JSON.parse(json), input.candidate);
      yield { type: "complete", payload: outcome.payload ?? { segments: [], answerability: "unknown", confidence: "low" }, usage,
        verification: { accepted: outcome.accepted, reason: outcome.reason } };
      return;
    }
    const parsed: ModelPayload = parsePayload(JSON.parse(json));
    if (parsed.segments.length !== emitted) throw new Error("invalid_model_payload");
    yield { type: "complete", payload: parsed, usage };
  }
}
