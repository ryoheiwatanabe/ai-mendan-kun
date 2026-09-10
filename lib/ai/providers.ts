import type { AnswerProvider, Bindings, EmbeddingProvider } from "../types.ts";
import { OpenAIProvider } from "./openai.ts";
import { GeminiProvider } from "./gemini.ts";
import { AnthropicProvider } from "./anthropic.ts";

export type ProviderName = "openai" | "gemini" | "anthropic";
export type EmbeddingProviderName = Exclude<ProviderName, "anthropic">;
function name(value: string | undefined): ProviderName {
  const selected = value || "gemini";
  if (selected !== "openai" && selected !== "gemini" && selected !== "anthropic") throw new Error("unsupported_provider");
  return selected;
}
function embeddingName(value: string | undefined, answer: ProviderName): EmbeddingProviderName {
  // ClaudeにEmbeddingはない。送信先を暗黙に増やさず、別Providerの明示設定を求める。
  if (!value && answer === "anthropic") throw new Error("embedding_provider_required");
  const selected = name(value || answer);
  if (selected === "anthropic") throw new Error("unsupported_embedding_provider");
  return selected;
}
export function providerNames(env: Bindings) {
  const answer = name(env.ANSWER_PROVIDER);
  return { answer, embedding: embeddingName(env.EMBEDDING_PROVIDER, answer) };
}
export function processorNames(env: Bindings): string {
  const selected = providerNames(env);
  const labels: Record<ProviderName, string> = { gemini: "GoogleのGemini API", openai: "OpenAI API", anthropic: "AnthropicのClaude API" };
  return [...new Set([selected.answer, selected.embedding])].map(provider => labels[provider]).join("・");
}
export function providerSecret(env: Bindings, selected = providerNames(env).answer): string {
  const key = selected === "anthropic" ? env.ANTHROPIC_API_KEY : selected === "openai" ? env.OPENAI_API_KEY : env.GEMINI_API_KEY;
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
  if (selected === "anthropic") return new AnthropicProvider(key, env.ANSWER_MODEL);
  return selected === "gemini" ? new GeminiProvider(key, env.ANSWER_MODEL)
    : new OpenAIProvider(key, env.ANSWER_MODEL || env.OPENAI_MODEL);
}
export function createEmbeddingProvider(env: Bindings): EmbeddingProvider {
  const selected = providerNames(env).embedding, key = providerSecret(env, selected);
  return selected === "gemini" ? new GeminiProvider(key, undefined, env.EMBEDDING_MODEL, dimensions(env))
    : new OpenAIProvider(key, undefined, env.EMBEDDING_MODEL, dimensions(env));
}
