import test from "node:test";
import assert from "node:assert/strict";
import { segmentKinds } from "../lib/answer/guard.ts";
import { answerSchema } from "../lib/ai/prompt.ts";

// モデルを入れ替えても同じ契約になるよう、種類の一覧は1か所を正本にする。
// Providerごとの対応表とschemaがずれると、会話応答が特定のモデルだけで失敗する。
test("回答schemaの種類は、guardの対応表と一致し、会話応答を含む", () => {
  const schema = answerSchema as {
    properties: { segments: { items: { properties: { kind: { enum: string[] } } } } };
  };
  const declared = schema.properties.segments.items.properties.kind.enum;
  assert.deepEqual([...declared].sort(), [...segmentKinds].sort());
  assert.ok(declared.includes("conversational"));
});
