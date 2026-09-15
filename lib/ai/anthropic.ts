import type { AnswerProvider, ModelPayload, Segment, SegmentKind } from "../types.ts";
import { parseSegment, parsePayload, segmentKinds } from "../answer/guard.ts";
import { completedSegments, readSse } from "./sse.ts";
import { answerSchema, verifySchema, instructions, modelConversation } from "./prompt.ts";
import { parseVerification } from "./verification.ts";

class ProviderError extends Error {}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function tokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ProviderError("invalid_provider_event");
  return value;
}
function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string") throw new ProviderError("invalid_model_payload");
  const normalized = value.toLowerCase() as T;
  if (!allowed.includes(normalized)) throw new ProviderError("invalid_model_payload");
  return normalized;
}

// Claude構造化出力はenum大小文字を保証しない。text/evidenceIds/claimsの本文には触れない。
function segment(value: unknown): Segment {
  if (!record(value)) throw new ProviderError("invalid_model_payload");
  try { return parseSegment({ ...value, kind: enumValue(value.kind, segmentKinds) }); }
  catch { throw new ProviderError("invalid_model_payload"); }
}

export class AnthropicProvider implements AnswerProvider {
  private readonly key: string;
  readonly model: string;
  constructor(key: string, model = "claude-haiku-4-5-20251001") {
    this.key = key; this.model = model;
  }

  async *stream(input: Parameters<AnswerProvider["stream"]>[0], signal: AbortSignal): ReturnType<AnswerProvider["stream"]> {
    try {
      signal.throwIfAborted();
      const purpose = input.purpose ?? "answer";
      const verifying = purpose === "verify";
      const userPayload: Record<string, unknown> = modelConversation(input.question, input.history, input.evidence);
      if (input.candidate) userPayload.candidate = input.candidate;
      if (input.repair) userPayload.repair = input.repair;
      if (input.lengthBudget) userPayload.lengthBudget = { mode: input.lengthBudget.mode, max: input.lengthBudget.max, target: input.lengthBudget.target };
      userPayload.purpose = purpose;
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "x-api-key": this.key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, stream: true, max_tokens: verifying ? 1024 : 4096,
          system: instructions(purpose),
          messages: [{ role: "user", content: JSON.stringify(userPayload) }],
          output_config: { format: { type: "json_schema", schema: verifying ? verifySchema : answerSchema } }
        }), signal, redirect: "manual"
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {});
        throw new ProviderError(`answer_http_${response.status}`);
      }

      let json = "", emitted = 0, nextBlock = 0;
      let started = false, finalizing = false, finished = false, stopped = false;
      let activeBlock: number | null = null;
      let usage: { input: number; output: number } | undefined;
      for await (const raw of readSse(response.body, signal)) {
        signal.throwIfAborted();
        if (raw.length > 150_000) throw new ProviderError("stream_frame_too_large");
        const event: unknown = JSON.parse(raw);
        if (!record(event) || typeof event.type !== "string") throw new ProviderError("invalid_provider_event");
        if (event.type === "error" || event.error) throw new ProviderError("provider_stream_error");
        let text = "";
        switch (event.type) {
          case "message_start": {
            const message = event.message;
            if (started || stopped || !record(message) || message.role !== "assistant"
              || !Array.isArray(message.content) || message.content.length || message.stop_reason != null)
              throw new ProviderError("invalid_provider_event");
            started = true;
            if (message.usage !== undefined) {
              if (!record(message.usage)) throw new ProviderError("invalid_provider_event");
              usage = { input: tokenCount(message.usage.input_tokens), output: tokenCount(message.usage.output_tokens) };
            }
            break;
          }
          case "content_block_start": {
            const block = event.content_block;
            if (!started || finalizing || stopped || activeBlock !== null || event.index !== nextBlock || !record(block))
              throw new ProviderError("invalid_provider_event");
            if (block.type === "refusal") throw new ProviderError("provider_refusal");
            if (block.type !== "text" || typeof block.text !== "string") throw new ProviderError("invalid_provider_event");
            activeBlock = nextBlock;
            text = block.text;
            break;
          }
          case "content_block_delta": {
            const delta = event.delta;
            if (stopped || activeBlock === null || event.index !== activeBlock || !record(delta))
              throw new ProviderError("invalid_provider_event");
            if (delta.type === "refusal_delta") throw new ProviderError("provider_refusal");
            if (delta.type !== "text_delta" || typeof delta.text !== "string") throw new ProviderError("invalid_provider_event");
            text = delta.text;
            break;
          }
          case "content_block_stop":
            if (stopped || activeBlock === null || event.index !== activeBlock) throw new ProviderError("invalid_provider_event");
            activeBlock = null;
            nextBlock++;
            break;
          case "message_delta": {
            if (!started || stopped || activeBlock !== null || !record(event.delta)) throw new ProviderError("invalid_provider_event");
            finalizing = true;
            const reason = event.delta.stop_reason;
            if (reason === "refusal") throw new ProviderError("provider_refusal");
            if (reason === "end_turn") finished = true;
            else if (reason != null) throw new ProviderError("provider_incomplete");
            if (event.usage !== undefined) {
              if (!record(event.usage)) throw new ProviderError("invalid_provider_event");
              const output = tokenCount(event.usage.output_tokens);
              if (usage) {
                if (output < usage.output) throw new ProviderError("invalid_provider_event");
                usage.output = output;
              }
            }
            break;
          }
          case "message_stop":
            if (!started || stopped || activeBlock !== null || !finished) throw new ProviderError("provider_incomplete");
            stopped = true;
            break;
          default:
            continue;
        }
        if (!text) continue;
        json += text;
        if (json.length > 24_000) throw new ProviderError("answer_too_large");
        if (verifying) continue;
        const segments = completedSegments(json);
        if (segments.length > 4) throw new ProviderError("too_many_segments");
        while (emitted < segments.length) yield { type: "segment", segment: segment(segments[emitted++]) };
      }
      signal.throwIfAborted();
      if (!finished || !stopped) throw new ProviderError("provider_incomplete");
      const parsed: unknown = JSON.parse(json);
      if (verifying) {
        const outcome = parseVerification(parsed, input.candidate);
        yield { type: "complete", payload: outcome.payload!, usage };
        return;
      }
      if (!record(parsed) || !Array.isArray(parsed.segments)) throw new ProviderError("invalid_model_payload");
      const payload: ModelPayload = parsePayload({ ...parsed, segments: parsed.segments.map(segment),
        answerability: enumValue(parsed.answerability, ["answerable", "partial", "unknown", "ambiguous"]),
        confidence: enumValue(parsed.confidence, ["high", "medium", "low"]) });
      if (payload.segments.length !== emitted) throw new ProviderError("invalid_model_payload");
      yield { type: "complete", payload, usage };
    } catch (error) {
      if (signal.aborted) throw new Error("provider_aborted");
      if (error instanceof ProviderError) throw new Error(error.message);
      throw new Error("provider_stream_error");
    }
  }
}
