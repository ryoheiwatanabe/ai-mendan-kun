import type { AnswerProvider, Bindings, EmbeddingProvider } from "../types.ts";
import { OpenAIProvider } from "./openai.ts";
import { GeminiProvider } from "./gemini.ts";

export type ProviderName = "openai" | "gemini";
function name(value: string | undefined): ProviderName {
  const selected = value || "gemini";
  if (selected !== "openai" && selected !== "gemini") throw new Error("unsupported_provider");
  return selected;
}
export function providerNames(env: Bindings) {
  return { answer: name(env.ANSWER_PROVIDER), embedding: name(env.EMBEDDING_PROVIDER || env.ANSWER_PROVIDER) };
}
export function providerSecret(env: Bindings, selected = providerNames(env).answer): string {
  const key = selected === "openai" ? env.OPENAI_API_KEY : env.GEMINI_API_KEY;
  if (!key) throw new Error("provider_not_configured");
  return key;
}
function dimensions(env: Bindings) {
  const value = Number(env.EMBEDDING_DIMENSIONS || 1536);
  if (!Number.isInteger(value) || value < 1 || value > 1536) throw new Error("invalid_embedding_dimensions");
  return value;
}
export function embeddingSignature(env: Bindings) {
  const selected = providerNames(env).embedding;
  const model = env.EMBEDDING_MODEL || (selected === "gemini" ? "gemini-embedding-2" : "text-embedding-3-small");
  return `${selected}:${model}:${dimensions(env)}:retrieval-v1`;
}
export function createAnswerProvider(env: Bindings): AnswerProvider {
  const selected = providerNames(env).answer, key = providerSecret(env, selected);
  return selected === "gemini" ? new GeminiProvider(key, env.ANSWER_MODEL)
    : new OpenAIProvider(key, env.ANSWER_MODEL || env.OPENAI_MODEL);
}
export function createEmbeddingProvider(env: Bindings): EmbeddingProvider {
  const selected = providerNames(env).embedding, key = providerSecret(env, selected);
  return selected === "gemini" ? new GeminiProvider(key, undefined, env.EMBEDDING_MODEL, dimensions(env))
    : new OpenAIProvider(key, undefined, env.EMBEDDING_MODEL, dimensions(env));
}
