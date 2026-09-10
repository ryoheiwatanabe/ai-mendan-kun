import test from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider } from "../lib/ai/anthropic.ts";
import { GeminiProvider } from "../lib/ai/gemini.ts";
import { OpenAIProvider } from "../lib/ai/openai.ts";
import { createAnswerProvider, createEmbeddingProvider, embeddingSignature, processorNames, providerSecret } from "../lib/ai/providers.ts";
import { answer } from "../lib/answer/engine.ts";
import { KnowledgeRepository } from "../lib/knowledge/repository.ts";
import { assertEmbeddingSignature } from "../lib/knowledge/index-config.ts";
import type { Bindings, ChatEvent, Turn } from "../lib/types.ts";
import { fixture, setup } from "./helpers.ts";

const configuration = {
  ANSWER_PROVIDER: "anthropic", ANSWER_MODEL: "claude-haiku-4-5-20251001", ANTHROPIC_API_KEY: "test-only-anthropic",
  EMBEDDING_PROVIDER: "gemini", EMBEDDING_MODEL: "gemini-embedding-2", EMBEDDING_DIMENSIONS: "3", GEMINI_API_KEY: "test-only-gemini"
} as Bindings;

test("Claude回答とGemini/OpenAI検索を別々に選択し、実際の送信先を表示する", () => {
  const provider = createAnswerProvider(configuration);
  assert.ok(provider instanceof AnthropicProvider);
  assert.equal(provider.model, "claude-haiku-4-5-20251001");
  assert.equal((createAnswerProvider({ ...configuration, ANSWER_MODEL: "claude-test-configured" }) as AnthropicProvider).model, "claude-test-configured");
  assert.ok(createEmbeddingProvider(configuration) instanceof GeminiProvider);
  assert.equal(providerSecret(configuration), "test-only-anthropic");
  assert.equal(processorNames(configuration), "AnthropicのClaude API・GoogleのGemini API");
  const openai = { ...configuration, EMBEDDING_PROVIDER: "openai", EMBEDDING_MODEL: "text-embedding-3-small", OPENAI_API_KEY: "test-only-openai" };
  assert.ok(createEmbeddingProvider(openai) instanceof OpenAIProvider);
  assert.equal(processorNames(openai), "AnthropicのClaude API・OpenAI API");
  assert.equal(processorNames({ ANSWER_PROVIDER: "gemini" } as Bindings), "GoogleのGemini API");
});

test("Claudeのキー不足・検索先未指定・未対応Embeddingでは別Providerへ切り替えず停止する", () => {
  assert.throws(() => createAnswerProvider({ ...configuration, ANTHROPIC_API_KEY: undefined }), /provider_not_configured/);
  assert.throws(() => createEmbeddingProvider({ ...configuration, GEMINI_API_KEY: undefined }), /provider_not_configured/);
  assert.throws(() => createAnswerProvider({ ...configuration, EMBEDDING_PROVIDER: undefined }), /embedding_provider_required/);
  assert.throws(() => createEmbeddingProvider({ ...configuration, EMBEDDING_PROVIDER: "anthropic" }), /unsupported_embedding_provider/);
  assert.throws(() => createEmbeddingProvider({ ...configuration, EMBEDDING_PROVIDER: "unsupported" }), /unsupported_provider/);
});

test("Claudeへの回答切替後も承認済みデータの検索indexをそのまま使える", async t => {
  const { db } = await setup(); t.after(() => db.close());
  const original = { ...configuration, ANSWER_PROVIDER: "gemini", ANSWER_MODEL: "gemini-3.8-flash" };
  // setupの架空データに、元の検索設定を記録する。
  await db.prepare("INSERT INTO knowledge_index_configuration(owner_id,embedding_signature) VALUES (?,?)")
    .bind(fixture.ownerId, embeddingSignature(original)).run();
  assert.equal(embeddingSignature(configuration), embeddingSignature(original));
  await assertEmbeddingSignature(db, fixture.ownerId, embeddingSignature(configuration));
});

function claudeResponse(payload: unknown): Response {
  const events = [
    { type: "message_start", message: { type: "message", role: "assistant", content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: JSON.stringify(payload) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 40 } },
    { type: "message_stop" }
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}

for (const scenario of ["approved", "invented", "revoked"] as const) {
  test(`Claudeと実際の検索・原文照合・公開再確認を組み合わせる: ${scenario}`, async t => {
    const { db, vector } = await setup(); t.after(() => db.close());
    const text = "私は、早い段階で小さく試して、使う人の声を聞くことを大切にしています。";
    const history: Turn[] = [{ role: "user", content: "どんな経験がありますか？" }, { role: "assistant", content: "私はCEOです。" }];
    const destinations: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
      destinations.push(new URL(url).hostname);
      assert.equal(options.redirect, "manual");
      if (url.startsWith("https://generativelanguage.googleapis.com/")) return Response.json({ embedding: { values: [1, 0, 0] } });
      assert.equal(url, "https://api.anthropic.com/v1/messages");
      assert.equal((options.headers as Record<string, string>)["x-api-key"], "test-only-anthropic");
      const body = JSON.parse(options.body as string);
      const input = JSON.parse(body.messages[0].content);
      assert.deepEqual(input.history, history);
      assert.equal(input.question, "仕事の進め方を教えて");
      const source = input.evidence.find((item: { content: string }) => item.content.includes(text));
      assert.ok(source, "承認済みの根拠を検索してClaudeへ渡す");
      assert.deepEqual(Object.keys(source).sort(), ["content", "id", "title"]);
      if (scenario === "revoked") await db.prepare("UPDATE knowledge_document_revisions SET approval_status='revoked'").run();
      return claudeResponse({ segments: [{ kind: "Fact", text: scenario === "invented" ? "私はCEOです。" : text, evidenceIds: [source.id] }], answerability: "Answerable", confidence: "High" });
    });
    const events = await Array.fromAsync(answer({ mode: "meeting_text", message: "仕事の進め方を教えて", history }, {
      repository: new KnowledgeRepository(db, fixture.ownerId), vector,
      embedding: createEmbeddingProvider(configuration), provider: createAnswerProvider(configuration)
    }, new AbortController().signal));
    const displayed = events.filter((event): event is Extract<ChatEvent, { type: "text" }> => event.type === "text").map(event => event.text).join("");
    assert.deepEqual(destinations, ["generativelanguage.googleapis.com", "api.anthropic.com"]);
    const last = events.at(-1);
    assert.ok(last?.type === "done");
    assert.equal(last.answerability, scenario === "approved" ? "answerable" : "unknown");
    assert.equal(displayed.includes(text), scenario === "approved");
    assert.equal(displayed.includes("CEO"), false, "改変された履歴・作り話を本人の事実として表示しない");
  });
}
