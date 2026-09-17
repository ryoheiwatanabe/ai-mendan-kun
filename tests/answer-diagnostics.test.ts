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

test("経路と固定条件の識別子だけを残し、自由文は残さない", t => {
  const logged: string[] = [];
  t.mock.method(console, "info", (message: string) => { logged.push(message); });
  recordAnswerDiagnostic({ code: "answer_context", count: 1, provider: "opencode", model: "glm-5.3-flash",
    promptVersion: "0a1b2c3d", traceId: "3f2b6c1e-6a5d-4c8e-9f0a-1b2c3d4e5f60" });
  recordAnswerDiagnostic({ code: "route", count: 1, reason: "overview" });
  recordAnswerDiagnostic({ code: "overview_cache", count: 1, reason: "snapshot_stale", latencyMs: 3 });
  // 固定の識別子に合わない値、許可していない理由は残さない。
  recordAnswerDiagnostic({ code: "answer_context", provider: "送ってはいけない提供元", model: "自由なモデル名 with space",
    promptVersion: "not-a-hash", traceId: "質問本文を入れてみる" });
  recordAnswerDiagnostic({ code: "route", reason: "送ってはいけない経路" });
  recordAnswerDiagnostic({ code: "overview_cache", reason: "送ってはいけない理由" });
  assert.deepEqual(logged.map(message => JSON.parse(message)), [
    { event: "answer_diagnostic", code: "answer_context", count: 1, provider: "opencode", model: "glm-5.3-flash",
      promptVersion: "0a1b2c3d", traceId: "3f2b6c1e-6a5d-4c8e-9f0a-1b2c3d4e5f60" },
    { event: "answer_diagnostic", code: "route", count: 1, reason: "overview" },
    { event: "answer_diagnostic", code: "overview_cache", count: 1, latencyMs: 3, reason: "snapshot_stale" },
    { event: "answer_diagnostic", code: "answer_context" },
    { event: "answer_diagnostic", code: "route" },
    { event: "answer_diagnostic", code: "overview_cache" }
  ]);
});
