// 入力確定の受入4例と、実行入口の0回確認（外部APIなし）。
import test from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot } from "../src/snapshot.mts";
import { candidatesFromRecords, finalizeCandidates, runComparisons, type FinalCandidate } from "../src/modeD.mts";
import type { RetestRecord } from "../src/retest.mts";
import type { KnowledgeRepository } from "../../../lib/knowledge/repository.ts";

const payload = JSON.stringify({ segments: [{ kind: "grounded_synthesis", text: "同じ候補",
  evidenceIds: [], claims: [] }], answerability: "answerable", confidence: "low" });

function record(input: { runId: string; evidenceIds: string[]; modelInputIds: string[]; snapshotHash: string; text?: string }): RetestRecord {
  const body = input.text
    ? JSON.stringify({ segments: [{ kind: "grounded_synthesis", text: input.text, evidenceIds: [], claims: [] }],
        answerability: "answerable", confidence: "low" })
    : payload;
  return { runId: input.runId, condition: "C", caseId: "M03", question: "q", history: [],
    evidenceIds: input.evidenceIds, handoff: { modelInputIds: input.modelInputIds },
    manifest: { baseSha: "base", snapshotHash: input.snapshotHash },
    pipelineLog: { candidate1: body, repairedCandidate: null } } as unknown as RetestRecord;
}

test("受入1: 保存入力が分かれる2記録は、1候補に統合しない", async () => {
  const snapshot = await buildSnapshot();
  const repository = snapshot.repository as unknown as KnowledgeRepository;
  const a = snapshot.chunks.find(chunk => chunk.title.includes("会社員時代"))!.id;
  const b = snapshot.chunks.find(chunk => chunk.title.includes("独立後"))!.id;
  const { candidates } = await candidatesFromRecords([
    record({ runId: "run-a", evidenceIds: [a, b], modelInputIds: [a], snapshotHash: snapshot.hash }),
    record({ runId: "run-b", evidenceIds: [a, b], modelInputIds: [b], snapshotHash: snapshot.hash })
  ], ["M03"]);
  assert.equal(candidates.length, 2, "段階Aでは統合しない");
  const finalized = await finalizeCandidates({ candidates, snapshot, repository });
  assert.equal(finalized.candidates.length, 2, "実入力が違うので統合しない");
  assert.equal(new Set(finalized.candidates.map(candidate => candidate.inputHash)).size, 2);
  assert.equal(finalized.stopped.length, 0);
});

test("受入2: 保存入力が元取得集合の外なら、停止理由にして送信しない", async () => {
  const snapshot = await buildSnapshot();
  const repository = snapshot.repository as unknown as KnowledgeRepository;
  const a = snapshot.chunks.find(chunk => chunk.title.includes("会社員時代"))!.id;
  const c = snapshot.chunks.find(chunk => chunk.title.includes("調べる") && !chunk.title.includes("具体例"))!.id;
  const { candidates } = await candidatesFromRecords([
    record({ runId: "run-x", evidenceIds: [a], modelInputIds: [c], snapshotHash: snapshot.hash })
  ], ["M03"]);
  assert.equal(candidates[0].inputProblem, "saved_input_inconsistent", "元IDへ黙って戻さない");
  const finalized = await finalizeCandidates({ candidates, snapshot, repository });
  assert.equal(finalized.candidates.length, 0);
  assert.equal(finalized.stopped[0].reason, "saved_input_inconsistent");
});

test("受入3: 実入力が同じなら統合し、由来は両方残す", async () => {
  const snapshot = await buildSnapshot();
  const repository = snapshot.repository as unknown as KnowledgeRepository;
  const a = snapshot.chunks.find(chunk => chunk.title.includes("会社員時代"))!.id;
  const b = snapshot.chunks.find(chunk => chunk.title.includes("独立後"))!.id;
  const { candidates } = await candidatesFromRecords([
    record({ runId: "run-1", evidenceIds: [a, b], modelInputIds: [a], snapshotHash: snapshot.hash }),
    record({ runId: "run-2", evidenceIds: [a], modelInputIds: [a], snapshotHash: snapshot.hash })
  ], ["M03"]);
  const finalized = await finalizeCandidates({ candidates, snapshot, repository });
  assert.equal(finalized.candidates.length, 1, "本文・順序まで同じなので統合する");
  assert.deepEqual(finalized.candidates[0].sourceRefs.map(ref => ref.runId), ["run-1", "run-2"]);
});

test("受入4: snapshotが違う由来は、有効な由来として混ぜない", async () => {
  const snapshot = await buildSnapshot();
  const repository = snapshot.repository as unknown as KnowledgeRepository;
  const a = snapshot.chunks.find(chunk => chunk.title.includes("会社員時代"))!.id;
  const { candidates } = await candidatesFromRecords([
    record({ runId: "run-old", evidenceIds: [a], modelInputIds: [a], snapshotHash: "different-snapshot" }),
    record({ runId: "run-new", evidenceIds: [a], modelInputIds: [a], snapshotHash: snapshot.hash })
  ], ["M03"]);
  const finalized = await finalizeCandidates({ candidates, snapshot, repository });
  assert.equal(finalized.stopped.length, 1, "snapshot不一致の由来は停止");
  assert.equal(finalized.stopped[0].reason, "snapshot_mismatch");
  assert.equal(finalized.candidates.length, 1);
  assert.deepEqual(finalized.candidates[0].sourceRefs.map(ref => ref.runId), ["run-new"], "有効な由来だけを残す");
});

test("不整合・破損の候補では、実行入口が呼ばれない（両API 0回）", async () => {
  const snapshot = await buildSnapshot();
  const repository = snapshot.repository as unknown as KnowledgeRepository;
  const a = snapshot.chunks.find(chunk => chunk.title.includes("会社員時代"))!.id;
  const c = snapshot.chunks.find(chunk => chunk.title.includes("調べる") && !chunk.title.includes("具体例"))!.id;
  const { candidates } = await candidatesFromRecords([
    record({ runId: "run-ok", evidenceIds: [a], modelInputIds: [a], snapshotHash: snapshot.hash }),
    record({ runId: "run-bad", evidenceIds: [a], modelInputIds: [c], snapshotHash: snapshot.hash }),
    record({ runId: "run-broken", evidenceIds: [a], modelInputIds: [a], snapshotHash: snapshot.hash, text: "x" }),
    { runId: "run-corrupt", condition: "C", caseId: "M03", question: "q", history: [], evidenceIds: [a],
      handoff: { modelInputIds: [] }, manifest: { baseSha: "base", snapshotHash: snapshot.hash },
      pipelineLog: { candidate1: "not json", repairedCandidate: null } } as unknown as RetestRecord
  ], ["M03"]);
  const { dropped } = await candidatesFromRecords([
    { runId: "run-corrupt", condition: "C", caseId: "M03", question: "q", history: [], evidenceIds: [a],
      handoff: { modelInputIds: [] }, manifest: { baseSha: "base", snapshotHash: snapshot.hash },
      pipelineLog: { candidate1: "not json", repairedCandidate: null } } as unknown as RetestRecord
  ], ["M03"]);
  assert.equal(dropped[0].reason, "candidate_not_parseable", "壊れたJSONは取り出し段階で停止");
  const finalized = await finalizeCandidates({ candidates, snapshot, repository });
  const called: string[] = [];
  const result = await runComparisons({ candidates: finalized.candidates, limit: 8,
    runner: async (candidate: FinalCandidate) => { called.push(candidate.sourceRunId); } });
  assert.deepEqual(called.sort(), ["run-broken", "run-ok"], "停止した候補だけを呼ばない");
  assert.equal(result.ran, 2);
  assert.ok(finalized.stopped.some(stopped => stopped.candidate.sourceRunId === "run-bad"), "不整合は停止");
  assert.ok(!called.includes("run-bad"), "不整合の候補は呼ばない");
});
