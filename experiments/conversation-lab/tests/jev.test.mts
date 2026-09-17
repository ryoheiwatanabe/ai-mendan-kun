// D条件のオフライン検証: JEVクライアントの要求・応答・接続先制限と、保存候補の取り出し。
// 外部APIは呼ばない（fetchを差し替える）。
import test from "node:test";
import assert from "node:assert/strict";
import { assertJevEndpoint, buildJevRequest, evaluateJev, jevQuestions, parseJevResponse } from "../src/jev.mts";
import { candidatesFromRecords } from "../src/modeD.mts";
import type { Evidence, Turn } from "../../../lib/types.ts";
import type { RetestRecord } from "../src/retest.mts";

const evidence: Evidence[] = [{ id: "chunk:1", kind: "chunk", revisionId: "rev", documentId: "doc", contentHash: "h",
  title: "強み", content: "辞書があったことから始まったと本人は述べています。", entities: [], rank: 0 }];
const history: Turn[] = [{ role: "user", content: "強みは？" }, { role: "assistant", content: "調べることが強みです。" }];

test("JEVへの要求は、状態と小さな判定項目を1回にまとめる", () => {
  const request = buildJevRequest({ question: "その強みはどう身につけましたか？", history, evidence, candidate: "辞書がきっかけです。" });
  assert.equal(request.model, "jev-latest");
  const state = JSON.parse(request.state as string) as { question: string; history: unknown[]; evidence: unknown[]; candidate: string };
  assert.equal(state.question, "その強みはどう身につけましたか？");
  assert.equal(state.history.length, 2);
  assert.equal(state.evidence.length, 1);
  assert.equal(state.candidate, "辞書がきっかけです。");
  assert.deepEqual(Object.keys(jevQuestions).length, 6);
  assert.equal(Object.keys(request.questions as object).length, 6);
});

test("応答は、確率・選択・confidenceを区別して生の値も保持する", () => {
  const parsed = parseJevResponse({ answers: {
    target_match: { type: "noul", probability: 0.82, confidence: 0.7 },
    aspect_match: { type: "choice", choice: "yes", probabilities: { yes: 0.9, no: 0.1 } }
  }, usage: { input_tokens: 120, output_tokens: 9 } });
  assert.equal(parsed.answers.target_match.probability, 0.82);
  assert.equal(parsed.answers.target_match.choice, null);
  assert.equal(parsed.answers.aspect_match.choice, "yes");
  assert.equal(parsed.answers.aspect_match.probability, null);
  assert.equal(parsed.usage.inputTokens, 120);
  assert.deepEqual(parseJevResponse(null).usage, { inputTokens: null, outputTokens: null });
});

test("接続先は許可リストのホストだけ", () => {
  assert.equal(assertJevEndpoint("https://api.typesafe.ai/v1/systemone", ["api.typesafe.ai"]), "api.typesafe.ai");
  assert.throws(() => assertJevEndpoint("https://example.com/v1", ["api.typesafe.ai"]), /host_not_allowed/);
});

test("JEVの失敗は judge_error として記録し、回答の誤りと混同しない", async () => {
  const original = globalThis.fetch;
  const call = async (status: number, body: string) => {
    globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof fetch;
    return evaluateJev({ question: "q", history: [], evidence: [], candidate: "c", apiKey: "test",
      timeoutMs: 5_000, endpoint: "https://api.typesafe.ai/v1/systemone" });
  };
  try {
    const ok = await call(200, JSON.stringify({ answers: { target_match: { type: "noul", probability: 0.9 } },
      usage: { input_tokens: 10, output_tokens: 2 } }));
    assert.equal(ok.ok, true);
    assert.equal(ok.answers.target_match.probability, 0.9);
    const unauthorized = await call(401, "{}");
    assert.equal(unauthorized.ok, false);
    assert.equal(unauthorized.errorKind, "http_401");
    const broken = await call(200, "not json");
    assert.equal(broken.errorKind, "invalid_json");
    globalThis.fetch = (() => new Promise((_resolve, reject) => {
      reject(new Error("network"));
    })) as unknown as typeof fetch;
    const failed = await evaluateJev({ question: "q", history: [], evidence: [], candidate: "c", apiKey: "test",
      timeoutMs: 5_000, endpoint: "https://api.typesafe.ai/v1/systemone" });
    assert.equal(failed.ok, false);
    assert.equal(failed.errorKind, "network_error");
  } finally {
    globalThis.fetch = original;
  }
});

test("保存候補から取り出し、未保存のモデル入力は推測せず印を付ける", () => {
  const base = { runId: "run-1", condition: "C", caseId: "M03", question: "q", history: [],
    evidenceIds: ["chunk:1"], answer: "a", stage: {}, usage: {}, execution: {}, manifest: {}, humanCriteria: {},
    evidenced: true } as unknown as RetestRecord;
  const withoutInput = { ...base, handoff: { modelInputIds: [] }, pipelineLog: { candidate1: JSON.stringify({ segments: [{ text: "候補A", evidenceIds: [], claims: [] }] }),
    repairedCandidate: JSON.stringify({ segments: [{ text: "候補B", evidenceIds: [], claims: [] }] }) } } as unknown as RetestRecord;
  const initial = candidatesFromRecords([withoutInput], ["M03"]);
  assert.equal(initial.length, 2, "初回と修復後を取り出す");
  assert.equal(initial[0].kind, "initial");
  assert.equal(initial[0].evidenceFidelity, "saved_evidence_ids_only");
  assert.equal(initial[0].engineAdopted, "未保存");
  const withInput = { ...withoutInput, runId: "run-2", handoff: { modelInputIds: ["chunk:1"] } } as unknown as RetestRecord;
  const recorded = candidatesFromRecords([withInput], ["M03"]);
  assert.equal(recorded[0].evidenceFidelity, "model_input_recorded");
  assert.equal(recorded[0].engineAdopted, "recorded");
  const duplicated = candidatesFromRecords([withoutInput, withoutInput], ["M03"]);
  assert.equal(duplicated.length, 2, "同じ候補は1回だけ");
});
