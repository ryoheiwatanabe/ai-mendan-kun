import type { AnswerProvider, Bindings, EmbeddingProvider } from "../types.ts";
import { OpenAIProvider, type StructuredOutput } from "./openai.ts";
import { OpenCodeProvider } from "./opencode.ts";
import { GeminiProvider } from "./gemini.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { WorkersAiEmbeddingProvider } from "./workersai.ts";

export type AnswerProviderName = "openai" | "gemini" | "anthropic" | "opencode";
// Workers AIは埋め込みだけを提供する。回答は別Providerを使う。
export type EmbeddingProviderName = "openai" | "gemini" | "workersai";
export type ProviderName = AnswerProviderName | EmbeddingProviderName;
function answerName(value: string | undefined): AnswerProviderName {
  const selected = value || "gemini";
  if (selected !== "openai" && selected !== "gemini" && selected !== "anthropic" && selected !== "opencode") throw new Error("unsupported_provider");
  return selected as AnswerProviderName;
}
function embeddingName(value: string | undefined, answer: AnswerProviderName): EmbeddingProviderName {
  // ClaudeとOpenCode GoにEmbeddingはない。送信先を暗黙に増やさず、別Providerの明示設定を求める。
  if (!value) {
    if (answer === "anthropic" || answer === "opencode") throw new Error("embedding_provider_required");
    return answer;
  }
  if (value === "openai" || value === "gemini" || value === "workersai") return value;
  if (value === "anthropic" || value === "opencode") throw new Error("unsupported_embedding_provider");
  throw new Error("unsupported_provider");
}
export function providerNames(env: Bindings) {
  const answer = answerName(env.ANSWER_PROVIDER);
  return { answer, embedding: embeddingName(env.EMBEDDING_PROVIDER, answer) };
}
export function processorNames(env: Bindings): string {
  const selected = providerNames(env);
  const labels: Record<ProviderName, string> = { gemini: "GoogleのGemini API", openai: "OpenAI API",
    anthropic: "AnthropicのClaude API", opencode: "OpenCode Go", workersai: "Cloudflare Workers AI" };
  const names = [...new Set([selected.answer, selected.embedding])].map(provider => labels[provider]);
  if (env.ANSWER_PIPELINE === "jev_v1") names.push("TypeSafe JEV（api.typesafe.ai）");
  return names.join("・");
}
export function providerSecret(env: Bindings, selected: AnswerProviderName = providerNames(env).answer): string {
  const key = selected === "anthropic" ? env.ANTHROPIC_API_KEY : selected === "openai" ? env.OPENAI_API_KEY
    : selected === "opencode" ? env.OPENCODE_API_KEY : env.GEMINI_API_KEY;
  if (!key) throw new Error("provider_not_configured");
  return key;
}
// OpenCode GoはDeepSeek系がjson_schemaを拒否するため、モデルに合わせて切り替える。
function structuredOutput(env: Bindings): StructuredOutput {
  const value = env.OPENCODE_JSON_MODE || "schema";
  if (value !== "object" && value !== "schema") throw new Error("invalid_opencode_json_mode");
  return value;
}
function dimensions(env: Bindings) {
  const value = Number(env.EMBEDDING_DIMENSIONS || 1536);
  if (!Number.isInteger(value) || value < 1 || value > 1536) throw new Error("invalid_embedding_dimensions");
  return value;
}
export function embeddingSignature(env: Bindings) {
  const selected = providerNames(env).embedding;
  const model = env.EMBEDDING_MODEL || (selected === "gemini" ? "gemini-embedding-2"
    : selected === "workersai" ? "@cf/baai/bge-m3" : "text-embedding-3-small");
  return `${selected}:${model}:${dimensions(env)}:retrieval-v1`;
}
export function createAnswerProvider(env: Bindings): AnswerProvider {
  const selected = providerNames(env).answer, key = providerSecret(env, selected);
  if (selected === "anthropic") return new AnthropicProvider(key, env.ANSWER_MODEL);
  if (selected === "opencode") return new OpenCodeProvider(key, env.ANSWER_MODEL, structuredOutput(env),
    `ai-mendan-kun:${env.OWNER_ID || "default"}`);
  return selected === "gemini" ? new GeminiProvider(key, env.ANSWER_MODEL)
    : new OpenAIProvider(key, env.ANSWER_MODEL || env.OPENAI_MODEL);
}
export function createEmbeddingProvider(env: Bindings): EmbeddingProvider {
  const selected = providerNames(env).embedding;
  if (selected === "workersai") {
    if (!env.AI) throw new Error("provider_not_configured");
    return new WorkersAiEmbeddingProvider(env.AI, env.EMBEDDING_MODEL, dimensions(env));
  }
  const key = providerSecret(env, selected);
  return selected === "gemini" ? new GeminiProvider(key, undefined, env.EMBEDDING_MODEL, dimensions(env))
    : new OpenAIProvider(key, undefined, env.EMBEDDING_MODEL, dimensions(env));
}
