// D条件のオフライン検証: JEVの計測範囲・応答検証、保存候補の取り出し、状態の分離、根拠の受け渡し。
// 外部APIは呼ばない（fetchを差し替える）。
import test from "node:test";
import assert from "node:assert/strict";
import { assertJevEndpoint, buildJevRequest, evaluateJev, jevQuestionIds, jevQuestions, parseJevResponse } from "../src/jev.mts";
import { candidatesFromRecords, runCurrentVerification, savedEvidenceItems } from "../src/modeD.mts";
import { buildSnapshot } from "../src/snapshot.mts";
import type { AnswerProvider, Evidence, Turn } from "../../../lib/types.ts";
import type { RetestRecord } from "../src/retest.mts";

const evidence: Evidence[] = [{ id: "chunk:1", kind: "chunk", revisionId: "rev", documentId: "doc", contentHash: "h",
  title: "強み", content: "辞書があったことから始まったと本人は述べています。", entities: [], rank: 0 }];
const history: Turn[] = [{ role: "user", content: "強みは？" }, { role: "assistant", content: "調べることが強みです。" }];
const allNoul = (value: number) => Object.fromEntries(jevQuestionIds.map(id => [id, { type: "noul", noul: value }]));

test("JEVへの要求は、共通規則と小さな判定項目を1回にまとめる", () => {
  const request = buildJevRequest({ question: "q", history, evidence, candidate: "c" });
  const state = JSON.parse(request.state as string) as { rules: string[]; evidence: unknown[] };
  assert.ok(state.rules.length >= 4, "共通規則を含める");
  assert.equal(state.evidence.length, 1);
  assert.equal(Object.keys(request.questions as object).length, 6);
  for (const [id, question] of Object.entries(jevQuestions)) {
    assert.doesNotMatch(question.instructions, /高(い|く)確率/, id);
    assert.doesNotMatch(question.instructions, /してください/, id);
  }
});

test("応答は6項目すべての存在・型・範囲を検証し、欠けや逸脱を成功にしない", () => {
  const good = parseJevResponse({ model: "jev-1", answers: allNoul(0.5), usage: { input_tokens: 10, output_tokens: 2 } });
  assert.equal(good.ok, true);
  assert.equal(good.returnedModel, "jev-1");
  assert.equal(good.answers.target_match.probability, 0.5);
  const cases: [string, unknown][] = [
    ["invalid_judge_payload_missing:aspect_match", { answers: { ...allNoul(0.5), aspect_match: undefined } }],
    ["invalid_judge_payload_type:target_match", { answers: { ...allNoul(0.5), target_match: { type: "choice", choice: "yes" } } }],
    ["invalid_judge_payload_range:target_match", { answers: { ...allNoul(0.5), target_match: { type: "noul", noul: 1.4 } } }],
    ["invalid_judge_payload_range:claims_supported", { answers: { ...allNoul(0.5), claims_supported: { type: "noul", noul: Number.NaN } } }],
    ["invalid_judge_payload", { usage: { input_tokens: 1 } }]
  ];
  for (const [errorKind, body] of cases) {
    const parsed = parseJevResponse(body);
    assert.equal(parsed.ok, false, JSON.stringify(body));
    assert.equal(parsed.errorKind, errorKind, JSON.stringify(body));
  }
});

test("JEVの完了時間は、ヘッダー到着ではなく本文の受信と検証までを測る", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ answers: allNoul(0.7), usage: { input_tokens: 5, output_tokens: 1 } })));
          controller.close();
        }, 250);
      }
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  try {
    const result = await evaluateJev({ question: "q", history: [], evidence: [], candidate: "c", apiKey: "test",
      timeoutMs: 5_000, endpoint: "https://api.typesafe.ai/v1/systemone" });
    assert.equal(result.ok, true);
    assert.ok((result.responseHeadersMs ?? 999) < 200, "ヘッダーは早く届く: " + String(result.responseHeadersMs));
    assert.ok(result.latencyMs >= 240, "完了時間に本文待ちを含む: " + String(result.latencyMs));
  } finally {
    globalThis.fetch = original;
  }
});

test("HTTPエラー・不正JSON・項目不足・接続先制限を区別する", async () => {
  const original = globalThis.fetch;
  const call = async (status: number, body: string) => {
    globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof fetch;
    return evaluateJev({ question: "q", history: [], evidence: [], candidate: "c", apiKey: "test",
      timeoutMs: 5_000, endpoint: "https://api.typesafe.ai/v1/systemone" });
  };
  try {
    const unauthorized = await call(401, "{}");
    assert.equal(unauthorized.ok, false);
    assert.equal(unauthorized.errorKind, "http_401");
    const broken = await call(200, "not json");
    assert.equal(broken.errorKind, "invalid_json");
    const short = await call(200, JSON.stringify({ answers: { target_match: { type: "noul", noul: 0.5 } } }));
    assert.equal(short.errorKind, "invalid_judge_payload_missing:aspect_match");
    assert.equal(assertJevEndpoint("https://api.typesafe.ai/v1/systemone", ["api.typesafe.ai"]), "api.typesafe.ai");
    assert.throws(() => assertJevEndpoint("https://example.com/v1", ["api.typesafe.ai"]), /host_not_allowed/);
  } finally {
    globalThis.fetch = original;
  }
});

test("保存候補の取り出しは内容hashで重複を除き、未保存の印を残す", async () => {
  const payload = JSON.stringify({ segments: [{ text: "候補A", evidenceIds: [], claims: [] }] });
  const base = { runId: "run-1", condition: "C", caseId: "M03", question: "q", history: [],
    evidenceIds: ["chunk:1"], handoff: { modelInputIds: [] },
    pipelineLog: { candidate1: payload, repairedCandidate: null } } as unknown as RetestRecord;
  const first = await candidatesFromRecords([base, base], ["M03"]);
  assert.equal(first.candidates.length, 1, "同じ内容は1件");
  assert.equal(first.candidates[0].evidenceFidelity, "saved_evidence_ids_only");
  assert.equal(first.candidates[0].engineAdopted, "未保存");
  const recorded = await candidatesFromRecords([{ ...base, runId: "run-2", handoff: { modelInputIds: ["chunk:1"] } } as unknown as RetestRecord], ["M03"]);
  assert.equal(recorded.candidates[0].evidenceFidelity, "model_input_recorded");
  const broken = await candidatesFromRecords([{ ...base, pipelineLog: { candidate1: "not json" } } as unknown as RetestRecord], ["M03"]);
  assert.equal(broken.candidates.length, 0);
  assert.equal(broken.dropped[0].reason, "candidate_not_parseable");
});

test("根拠はチャンクとFactの両方を引き当て、引けないIDを報告する", async () => {
  const snapshot = await buildSnapshot();
  const chunk = snapshot.chunks.find(entry => entry.title.includes("調べる") && !entry.title.includes("具体例"))!;
  const fact = "fact:" + chunk.revisionId + ":career-alpha";
  const resolved = savedEvidenceItems(snapshot, [chunk.id, fact, "chunk:missing"]);
  assert.deepEqual(resolved.items.map(item => item.kind), ["chunk", "fact"]);
  assert.deepEqual(resolved.items.map(item => item.id), [chunk.id, fact]);
  assert.deepEqual(resolved.missing, ["chunk:missing"]);
});

test("現行校閲の実行エラーは、却下と区別して記録する", async () => {
  const candidate = { caseId: "M03", sourceRunId: "run", condition: "C", kind: "initial" as const, question: "q", history: [],
    evidenceIds: [], candidate: "同期的な文。", payload: JSON.stringify({ segments: [{ kind: "grounded_synthesis", text: "同期的な文。",
      evidenceIds: [], claims: [] }], answerability: "answerable", confidence: "low" }),
    evidenceFidelity: "saved_evidence_ids_only" as const, engineAdopted: "未保存", contentHash: "h" };
  const broken = { async *stream() { throw new Error("provider_unavailable"); } } as unknown as AnswerProvider;
  const failed = await runCurrentVerification({ candidate, evidence, provider: broken, timeoutMs: 5_000 });
  assert.equal(failed.executionStatus, "error", "利用不能は実行エラー");
  assert.equal(failed.verdict, null, "実行エラーを却下にしない");
  assert.ok(typeof failed.errorKind === "string" && failed.errorKind.length > 0, "理由コードを残す");
  // 保存済み候補の中身が壊れている場合も、呼ぶ前に実行エラーとして弾く。
  const corrupt = await runCurrentVerification({ candidate: { ...candidate, payload: "not json" }, evidence, provider: broken, timeoutMs: 5_000 });
  assert.equal(corrupt.executionStatus, "error");
  assert.equal(corrupt.errorKind, "candidate_not_parseable");
  assert.equal(corrupt.verdict, null);
});
