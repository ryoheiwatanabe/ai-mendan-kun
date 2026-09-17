// D条件のオフライン検証: JEVの計測範囲・応答検証、保存候補の取り出し、状態の分離、根拠の受け渡し。
// 外部APIは呼ばない（fetchを差し替える）。
import test from "node:test";
import assert from "node:assert/strict";
import { assertJevEndpoint, buildJevRequest, evaluateJev, jevQuestionIds, jevQuestions, parseJevResponse } from "../src/jev.mts";
import { candidatesFromRecords, parseCandidatePayload, preflightProblems, runCurrentVerification, savedEvidenceItems } from "../src/modeD.mts";
import { currentChunks } from "../src/snapshot.mts";
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

test("保存候補の取り出し（段階A）は統合せず、未保存の印を残す", async () => {
  const payload = JSON.stringify({ segments: [{ text: "候補A", evidenceIds: [], claims: [] }] });
  const base = { runId: "run-1", condition: "C", caseId: "M03", question: "q", history: [],
    evidenceIds: ["chunk:1"], handoff: { modelInputIds: [] },
    pipelineLog: { candidate1: payload, repairedCandidate: null } } as unknown as RetestRecord;
  const first = await candidatesFromRecords([base, base], ["M03"]);
  assert.equal(first.candidates.length, 2, "段階Aでは統合しない（統合はfinalize）");
  assert.equal(first.candidates[0].evidenceFidelity, "saved_evidence_ids_only");
  assert.equal(first.candidates[0].engineAdopted, "未保存");
  const recorded = await candidatesFromRecords([{ ...base, runId: "run-2", handoff: { modelInputIds: ["chunk:1"] } } as unknown as RetestRecord], ["M03"]);
  assert.equal(recorded.candidates[0].evidenceFidelity, "model_input_recorded");
  const broken = await candidatesFromRecords([{ ...base, pipelineLog: { candidate1: "not json" } } as unknown as RetestRecord], ["M03"]);
  assert.equal(broken.candidates.length, 0);
  assert.equal(broken.dropped[0].reason, "candidate_not_parseable");
});

test("根拠の引き当ては、Factの完全ID・公開・所属を照合する", async () => {
  const snapshot = await buildSnapshot();
  const repository = snapshot.repository as unknown as import("../../../lib/knowledge/repository.ts").KnowledgeRepository;
  const career = snapshot.chunks.find(entry => entry.title.includes("会社員時代"))!;
  const other = snapshot.chunks.find(entry => entry.title.includes("調べる") && !entry.title.includes("具体例"))!;
  const correctFact = "fact:" + career.revisionId + ":career-alpha";
  const good = await savedEvidenceItems(snapshot, repository, [career.id, correctFact, "chunk:missing"]);
  assert.deepEqual(good.items.map(item => item.kind), ["chunk", "fact"], "正しい所属のFactだけが通る");
  assert.deepEqual(good.items.map(item => item.id), [career.id, correctFact]);
  assert.deepEqual(good.missing, ["chunk:missing"]);
  assert.deepEqual(good.problems, []);
  assert.ok(good.items[1].text.includes("アルファ電子"), "Factの承認文を使う");
  // 別文書のrevisionと組み合わせたFactは、所属の照合で止める。
  const wrongOwner = "fact:" + other.revisionId + ":career-alpha";
  const bad = await savedEvidenceItems(snapshot, repository, [wrongOwner]);
  assert.equal(bad.items.length, 0, "所属違いは解決しない");
  // 完全IDで照合するため、別revisionを組み合わせたIDは公開Fact集合に存在せず missing になる。
  assert.deepEqual(bad.missing, [wrongOwner]);
  assert.deepEqual(bad.problems, []);
  // Fact自身の公開・承認、文書の公開・現行版、ownerのいずれが外れても、公開Fact集合に入らず送信しない。
  const canonical = correctFact.slice("fact:".length);
  const mutations: [string, () => Promise<unknown>][] = [
    ["fact_private", () => snapshot.db.prepare("UPDATE exact_facts SET visibility='private' WHERE id=?").bind(canonical).run()],
    ["fact_unapproved", () => snapshot.db.prepare("UPDATE exact_facts SET visibility='public',approval_status='draft' WHERE id=?").bind(canonical).run()],
    ["other_owner", () => snapshot.db.prepare("UPDATE exact_facts SET approval_status='approved',visibility='public',owner_id='other' WHERE id=?").bind(canonical).run()],
    ["doc_private", () => snapshot.db.prepare("UPDATE exact_facts SET owner_id='fictional-minato' WHERE id=?").bind(canonical).run()
      .then(() => snapshot.db.prepare("UPDATE knowledge_document_revisions SET visibility='private' WHERE id=?").bind(career.revisionId).run())],
    ["doc_not_current", () => snapshot.db.prepare("UPDATE knowledge_document_revisions SET visibility='public' WHERE id=?").bind(career.revisionId).run()
      .then(() => snapshot.db.prepare("UPDATE knowledge_documents SET active_revision_id='rev_other' WHERE id=?").bind(career.documentId).run())]
  ];
  for (const [name, mutate] of mutations) {
    await mutate();
    const result = await savedEvidenceItems(snapshot, repository, [correctFact]);
    assert.equal(result.items.length, 0, name + " は送信対象にしない");
    assert.deepEqual(result.problems, [], name + " は所属の不一致ではなく集合から外れる");
  }
});

test("候補の取り出しは、同じ内容の由来をすべて残す", async () => {
  const payload = JSON.stringify({ segments: [{ text: "同じ候補", evidenceIds: [], claims: [] }] });
  const base = { runId: "run-1", condition: "C", caseId: "M03", question: "q", history: [], evidenceIds: ["chunk:1"],
    handoff: { modelInputIds: [] }, manifest: { baseSha: "a", snapshotHash: "s" },
    pipelineLog: { candidate1: payload, repairedCandidate: null } } as unknown as RetestRecord;
  const { candidates } = await candidatesFromRecords([base, { ...base, runId: "run-2" } as unknown as RetestRecord], ["M03"]);
  assert.equal(candidates.length, 2, "段階Aでは各記録を別々に保持する");
  assert.deepEqual(candidates.map(candidate => candidate.sourceRefs.map(ref => ref.runId)), [["run-1"], ["run-2"]]);
});

test("壊れた候補は、両校閲を呼ぶ前に止める", () => {
  assert.equal(parseCandidatePayload(JSON.stringify({ segments: [{ kind: "grounded_synthesis", text: "a", evidenceIds: [], claims: [] }],
    answerability: "answerable", confidence: "low" })).ok, true);
  assert.equal(parseCandidatePayload("not json").reason, "candidate_invalid_payload");
  assert.equal(parseCandidatePayload(JSON.stringify({ segments: [], answerability: "answerable", confidence: "low" })).reason, "candidate_no_segments");
  const problems = preflightProblems({ missing: ["chunk:x"], problems: ["fact_revision_mismatch"],
    dropped: ["chunk:y"], candidate: { ok: false, reason: "candidate_invalid_payload" },
    snapshotMismatch: true, keyProblem: null, endpointMismatch: false });
  assert.deepEqual(problems, ["evidence_missing:chunk:x", "fact_revision_mismatch", "evidence_not_public:chunk:y",
    "candidate_invalid_payload", "snapshot_mismatch"]);
  assert.deepEqual(preflightProblems({ missing: [], problems: [], dropped: [], candidate: { ok: true, reason: null },
    snapshotMismatch: false, keyProblem: null, endpointMismatch: true }), ["endpoint_mismatch"]);
});

test("保存済みモデル入力がある場合は、そのID列を送信対象に採用する", async () => {
  const payload = JSON.stringify({ segments: [{ text: "候補", evidenceIds: [], claims: [] }] });
  const record = { runId: "run-1", condition: "C", caseId: "M03", question: "q", history: [],
    evidenceIds: ["chunk:A", "chunk:B"], handoff: { modelInputIds: ["chunk:B"] },
    pipelineLog: { candidate1: payload, repairedCandidate: null } } as unknown as RetestRecord;
  const { candidates } = await candidatesFromRecords([record], ["M03"]);
  assert.deepEqual(candidates[0].savedInputIds, ["chunk:B"], "保存入力のID列を送信対象として保持する");
  assert.deepEqual(candidates[0].evidenceIds, ["chunk:A", "chunk:B"], "元取得IDは別に保持する");
  assert.equal(candidates[0].evidenceFidelity, "model_input_recorded");
});
