// Dの実行経路（runComparisons / compareCandidate）の受入: 送信入口の回数と、確定後の状態変化での停止。
// 外部APIは呼ばない（fetchとproviderを差し替える）。
import test from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot } from "../src/snapshot.mts";
import { candidatesFromRecords, compareCandidate, finalizeCandidates, runComparisons } from "../src/modeD.mts";
import { jevQuestionIds } from "../src/jev.mts";
import type { RetestRecord } from "../src/retest.mts";
import type { AnswerProvider, ModelPayload } from "../../../lib/types.ts";
import type { KnowledgeRepository } from "../../../lib/knowledge/repository.ts";

// JEVの鍵は環境変数から読む。オフライン試験ではダミーを入れる（実キーは使わない）。
process.env.TYPESAFE_API_KEY = "test-key";

const payload = JSON.stringify({ segments: [{ kind: "grounded_synthesis", text: "候補本文",
  evidenceIds: [], claims: [] }], answerability: "answerable", confidence: "low" });

function record(input: { runId: string; evidenceIds: string[]; modelInputIds?: string[]; body?: string }): RetestRecord {
  return { runId: input.runId, condition: "C", caseId: "M03", question: "q", history: [],
    evidenceIds: input.evidenceIds, handoff: { modelInputIds: input.modelInputIds ?? [] },
    manifest: { baseSha: "base", snapshotHash: "" },
    pipelineLog: { candidate1: input.body ?? payload, repairedCandidate: null } } as unknown as RetestRecord;
}

// 現行校閲の擬似提供元。候補と同じpayloadを返すので合格になる。
function providerOf(): AnswerProvider {
  return { async *stream(input: Parameters<AnswerProvider["stream"]>[0]) {
    yield { type: "complete", payload: JSON.parse(input.candidate ? JSON.stringify(input.candidate) : payload) as ModelPayload,
      usage: { input: 1, output: 1 }, verification: { accepted: true, reason: "accepted" } };
  } } as unknown as AnswerProvider;
}

const jevOk = () => JSON.stringify({ model: "jev-test",
  answers: Object.fromEntries(jevQuestionIds.map(id => [id, { type: "noul", noul: 0.5 }])),
  usage: { input_tokens: 3, output_tokens: 1 } });

test("JSONとして有効でも、answerability等が不正な候補は実行入口を呼ばない", async () => {
  const snapshot = await buildSnapshot();
  const repository = snapshot.repository as unknown as KnowledgeRepository;
  const a = snapshot.chunks.find(chunk => chunk.title.includes("会社員時代"))!.id;
  const invalid = JSON.stringify({ segments: [{ kind: "grounded_synthesis", text: "x", evidenceIds: [], claims: [] }],
    answerability: "bogus", confidence: "low" });
  const { candidates } = await candidatesFromRecords([record({ runId: "run-invalid", evidenceIds: [a], body: invalid })], ["M03"]);
  assert.equal(candidates[0].inputProblem, "candidate_invalid_payload", "段階Aで停止理由になる");
  const finalized = await finalizeCandidates({ candidates, snapshot, repository });
  const called: string[] = [];
  await runComparisons({ candidates: finalized.candidates, limit: 8, runner: async candidate => { called.push(candidate.sourceRunId); } });
  assert.deepEqual(called, [], "実行入口は0回");
  assert.equal(finalized.stopped.length, 1);
});

test("正常候補は、両側が1回ずつ呼ばれ、記録のinputHashが確定結果と一致する", async () => {
  const snapshot = await buildSnapshot();
  const repository = snapshot.repository as unknown as KnowledgeRepository;
  const a = snapshot.chunks.find(chunk => chunk.title.includes("会社員時代"))!.id;
  const { candidates } = await candidatesFromRecords([record({ runId: "run-ok", evidenceIds: [a], modelInputIds: [a] })], ["M03"]);
  const finalized = await finalizeCandidates({ candidates, snapshot, repository });
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(jevOk(), { status: 200 })) as unknown as typeof fetch;
  try {
    const seen: string[] = [];
    await runComparisons({ candidates: finalized.candidates, limit: 8, runner: async candidate => {
      seen.push(candidate.sourceRunId);
      const result = await compareCandidate({ candidate, items: candidate.items, inputHash: candidate.inputHash,
        snapshotHash: snapshot.hash, baseSha: "base", currentModel: "m", currentEndpoint: "e",
        provider: providerOf(), timeoutMs: 5_000, useJev: true });
      assert.equal(result.current.apiCalls + result.jev.apiCalls, 2, "両側1回ずつ");
      assert.equal(result.inputHash, candidate.inputHash, "記録のinputHashが確定結果と一致");
      assert.deepEqual(result.requestedEvidenceIds, [a], "採用IDは保存入力");
      assert.deepEqual(result.sentEvidenceIds, [a]);
      assert.deepEqual(result.missingEvidenceIds, [], "意図して選ばなかった元IDを欠落にしない");
    } });
    assert.deepEqual(seen, ["run-ok"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("確定後に根拠が変わったら、JEVは送らず現行校閲の1回だけを維持する", async () => {
  const snapshot = await buildSnapshot();
  const repository = snapshot.repository as unknown as KnowledgeRepository;
  const a = snapshot.chunks.find(chunk => chunk.title.includes("会社員時代"))!.id;
  const { candidates } = await candidatesFromRecords([record({ runId: "run-change", evidenceIds: [a], modelInputIds: [a] })], ["M03"]);
  const finalized = await finalizeCandidates({ candidates, snapshot, repository });
  const flaky = { revalidate: async (items: unknown[]) => (Array.isArray(items) && items.length ? false : false) } as unknown as KnowledgeRepository;
  const original = globalThis.fetch;
  let jevCalls = 0;
  globalThis.fetch = (async () => { jevCalls += 1; return new Response(jevOk(), { status: 200 }); }) as unknown as typeof fetch;
  try {
    const result = await compareCandidate({ candidate: finalized.candidates[0], items: finalized.candidates[0].items,
      inputHash: finalized.candidates[0].inputHash, snapshotHash: snapshot.hash, baseSha: "base",
      currentModel: "m", currentEndpoint: "e", provider: providerOf(), timeoutMs: 5_000, useJev: true, repository: flaky });
    assert.equal(result.current.apiCalls, 1, "現行校閲は実行済みの1回を維持");
    assert.equal(result.jev.executionStatus, "not_run");
    assert.equal(result.jev.apiCalls, 0, "JEVは0回");
    assert.equal(jevCalls, 0, "JEVの送信入口は呼ばれない");
    assert.equal(result.jev.reason, "evidence_changed_before_jev");
  } finally {
    globalThis.fetch = original;
  }
});

test("--no-jev は、現行1回・JEV0回になる", async () => {
  const snapshot = await buildSnapshot();
  const repository = snapshot.repository as unknown as KnowledgeRepository;
  const a = snapshot.chunks.find(chunk => chunk.title.includes("会社員時代"))!.id;
  const { candidates } = await candidatesFromRecords([record({ runId: "run-nojev", evidenceIds: [a], modelInputIds: [a] })], ["M03"]);
  const finalized = await finalizeCandidates({ candidates, snapshot, repository });
  const result = await compareCandidate({ candidate: finalized.candidates[0], items: finalized.candidates[0].items,
    inputHash: finalized.candidates[0].inputHash, snapshotHash: snapshot.hash, baseSha: "base",
    currentModel: "m", currentEndpoint: "e", provider: providerOf(), timeoutMs: 5_000, useJev: false, repository });
  assert.equal(result.current.apiCalls, 1);
  assert.equal(result.jev.executionStatus, "not_run");
  assert.equal(result.jev.apiCalls, 0);
  assert.equal(result.jev.reason, "--no-jev");
});
