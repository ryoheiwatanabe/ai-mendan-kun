import test from "node:test";
import assert from "node:assert/strict";
import { recordAnswerDiagnostic } from "../lib/answer/diagnostics.ts";

test("診断ログは固定理由と有限非負数だけを残し、本文や識別子を除外する", t => {
  const logged: string[] = [];
  t.mock.method(console, "info", (message: string) => { logged.push(message); });
  recordAnswerDiagnostic({ code: "generation_complete", count: 1, latencyMs: 1.5, inputTokens: 42, outputTokens: 8,
    question: "送ってはいけない質問", text: "送ってはいけない本文", ownerId: "hidden-owner", evidenceIds: ["hidden-id"],
    ids: ["hidden-id"] });
  recordAnswerDiagnostic({ code: "verification_error", count: -1, latencyMs: Infinity, inputTokens: "123", outputTokens: NaN });
  for (const value of [null, "本文", [], { code: "任意の理由と秘密情報" }, { code: 1 }]) recordAnswerDiagnostic(value);
  assert.deepEqual(logged.map(message => JSON.parse(message)), [
    { event: "answer_diagnostic", code: "generation_complete", count: 1, latencyMs: 1.5, inputTokens: 42, outputTokens: 8 },
    { event: "answer_diagnostic", code: "verification_error" }
  ]);
});

test("診断入力の取得やログ書込の例外を回答処理へ伝播させない", t => {
  t.mock.method(console, "info", () => { throw new Error("logging_unavailable"); });
  assert.doesNotThrow(() => recordAnswerDiagnostic({ code: "no_evidence", count: 0 }));
  assert.doesNotThrow(() => recordAnswerDiagnostic({ get code() { throw new Error("invalid_input"); } }));
});
