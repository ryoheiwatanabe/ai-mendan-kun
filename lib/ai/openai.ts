import type { AnswerProvider, EmbeddingProvider, ModelPayload } from "../types.ts";
import { parseSegment } from "../answer/guard.ts";
import { completedSegments, readSse } from "./sse.ts";

import { answerSchema, answerSystemPrompt } from "./prompt.ts";

export class OpenAIProvider implements AnswerProvider, EmbeddingProvider {
  private readonly key: string;
  readonly model: string;
  readonly embeddingModel: string;
  readonly dimensions: number;
  constructor(key: string, model = "gpt-4.1-mini", embeddingModel = "text-embedding-3-small", dimensions = 1536) {
    this.key = key; this.model = model; this.embeddingModel = embeddingModel; this.dimensions = dimensions;
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
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

  async *stream(input: Parameters<AnswerProvider["stream"]>[0], signal: AbortSignal): ReturnType<AnswerProvider["stream"]> {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, store: false, stream: true, stream_options: { include_usage: true },
        max_completion_tokens: 1800, temperature: 0,
        messages: [{ role: "system", content: answerSystemPrompt }, { role: "user", content: JSON.stringify({
          question: input.question, history: input.history,
          evidence: input.evidence.map(item => ({ id: item.id, title: item.title, content: item.content }))
        }) }],
        response_format: { type: "json_schema", json_schema: { name: "grounded_answer", strict: true, schema: answerSchema } }
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
      const segments = completedSegments(json);
      if (segments.length > 4) throw new Error("too_many_segments");
      while (emitted < segments.length) {
        yield { type: "segment", segment: parseSegment(segments[emitted++]) };
      }
    }
    if (!finished) throw new Error("provider_incomplete");
    const parsed = JSON.parse(json) as ModelPayload;
    if (!Array.isArray(parsed.segments) || parsed.segments.length !== emitted || !["answerable", "partial", "unknown", "ambiguous"].includes(parsed.answerability)
      || !["high", "medium", "low"].includes(parsed.confidence)) throw new Error("invalid_model_payload");
    yield { type: "complete", payload: parsed, usage };
  }
}
