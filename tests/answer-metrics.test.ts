import test from "node:test";
import assert from "node:assert/strict";
import { createAnswerMetrics } from "../lib/answer/metrics.ts";
import { TypeSafeJev } from "../lib/ai/jev.ts";
import { WorkersAiJev } from "../lib/ai/jev-workers-ai.ts";
import type { Diagnostic, Evidence } from "../lib/types.ts";

const evidence: Evidence[] = [{ id: "sample", revisionId: "r", documentId: "d", title: "資料", content: "設計を担当。",
  contentHash: "hash", entities: [], kind: "chunk", rank: 1 }];

for (const backend of ["http", "workers"] as const) test(`${backend}: JEVの全用途・失敗を通信単位で数え、中止前や重複の段階記録は加算しない`, async t => {
  const metrics = createAnswerMetrics();
  let requests = 0, fail = false;
  const respond = (input: any) => {
    requests++;
    if (fail) throw new Error("private upstream detail");
    return { answers: Object.fromEntries(Object.entries(input.questions).map(([id, q]) => {
      const question = q as any;
      return [id, question.type === "noul" ? { type: "noul", noul: .99 }
        : question.type === "score" ? { type: "score", score: 1, confidence: .9 }
          : { type: "choice", choice: Object.keys(question.criteria)[0], confidence: .9 }];
    })), ...(requests === 2 ? {} : { usage: { input_tokens: 10, output_tokens: 2 } }) };
  };
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => Response.json(respond(JSON.parse(init.body as string))));
  const judge = backend === "http" ? new TypeSafeJev("test-only", 4000, metrics.record)
    : new WorkersAiJev({ run: async (_model, input) => ({ result: respond(input) }) }, undefined, metrics.record);
  const signal = new AbortController().signal;
  await judge.checkScope({ question: "担当は？", history: [], evidence, maxJudgments: 10 }, signal);
  await judge.screenCandidates({ question: "担当は？", history: [], evidence, limit: 1 }, signal);
  await judge.checkRoutes({ question: "担当は？", history: [], routes: [{ id: "ranked", evidence }] }, signal);
  await judge.check({ question: "担当は？", history: [], evidence, candidate: "設計を担当。" }, signal);
  fail = true;
  await assert.rejects(judge.check({ question: "担当は？", history: [], evidence, candidate: "設計を担当。" }, signal));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(judge.check({ question: "担当は？", history: [], evidence, candidate: "設計を担当。" }, abort.signal));
  metrics.record({ code: "jev_attempt", count: 6 });
  metrics.record({ code: "jev_complete", count: 1, inputTokens: 100, outputTokens: 200, latencyMs: 100000 });
  const result = metrics.snapshot();
  assert.equal(requests, 5);
  assert.equal(result.jev.calls, requests);
  assert.equal(result.jev.failed, 1);
  assert.deepEqual(result.jev.byPurpose, { scope: 1, screening: 1, routes: 1, verification: 2, input_normalization: 0,
    intake_review: 0 });
  assert.equal(result.jev.inputTokens, 30);
  assert.equal(result.jev.outputTokens, 6);
  assert.equal(result.jev.usageCalls, 3);
  assert.ok(result.jev.milliseconds < 100000);
});

test("集計は取得できた数値だけを写し、未取得・0・別の回答を区別する", () => {
  const metrics = createAnswerMetrics();
  assert.equal(metrics.snapshot().jev.inputTokens, null);
  const events = [
    { code: "generation_attempt" }, { code: "generation_complete", latencyMs: 15, inputTokens: 0, outputTokens: 0 },
    { code: "repair_attempted" }, { code: "generation_attempt" }, { code: "repair_complete", latencyMs: 25 },
    { code: "candidates_retrieved", count: 6, ids: ["private-id"], reason: "private-text" },
    { code: "candidates_adopted", count: 2 }, { code: "retrieval_complete", latencyMs: 8 },
    { code: "candidates_adopted", count: -1 }, { code: "retrieval_complete", latencyMs: NaN }
  ] as Diagnostic[];
  events.forEach(metrics.record);
  const result = metrics.snapshot();
  assert.deepEqual(result.generation, { calls: 2, repairs: 1, completed: 2, milliseconds: 40, inputTokens: 0, outputTokens: 0, usageCalls: 1 });
  assert.deepEqual(result.retrieval, { candidates: 6, adopted: 2, milliseconds: 8 });
  assert.doesNotMatch(JSON.stringify(result), /private/);
  result.jev.calls = 99;
  assert.equal(metrics.snapshot().jev.calls, 0);
  assert.equal(createAnswerMetrics().snapshot().generation.calls, 0);
});

test("診断先が例外を投げてもJEVの結果を失わない", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ answers: { claims_supported: { type: "noul", noul: .99 } } }));
  const judge = new TypeSafeJev("test-only", 4000, () => { throw new Error("collector_failed"); });
  const result = await judge.check({ question: "担当は？", history: [], evidence, candidate: "設計を担当。", axes: ["claims_supported"] }, new AbortController().signal);
  assert.equal(result.scores.claims_supported, .99);
});
