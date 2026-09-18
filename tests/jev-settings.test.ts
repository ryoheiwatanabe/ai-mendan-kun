import test from "node:test";
import assert from "node:assert/strict";
import { POST as chat } from "../app/api/chat/route.ts";
import { GET as adminGet, POST as adminPost } from "../app/api/admin/jev-settings/route.ts";
import { POST as probePost } from "../app/api/admin/jev-probe/route.ts";
import { defaultJevThresholds, jevQuestionIds, type JevAxis, type JevScores } from "../lib/ai/jev.ts";
import { jevScopeNoulIds, jevScopeOrder, type JevScopeNoulAxis } from "../lib/ai/jev-scope.ts";
import { asksForOrigin, defaultJevSettings, jevScopeDecision, jevVerdict, parseJevSettings, scopeDirective,
  softenForLowConfidence, type JevSettings } from "../lib/answer/jev-settings.ts";
import { recordScoreSample, recordStageTiming, resolveJevSettings, scoreSamples, stageMetrics, JevSettingsStore } from "../lib/answer/jev-settings-store.ts";
import { stageBudget } from "../lib/answer/jev-pipeline.ts";
import { WorkersAiJev } from "../lib/ai/jev-workers-ai.ts";
import type { ParsedAnswer } from "../lib/ai/jev-primitives.ts";
import { adminAllowed } from "../lib/security/admin.ts";
import { jevBindings } from "./fixtures/jev.ts";
import { LocalDatabase } from "./helpers.ts";

const scores = (changes: Partial<JevScores> = {}): JevScores =>
  Object.fromEntries(jevQuestionIds.map(axis => [axis, changes[axis] ?? .97])) as JevScores;
const settingsWith = (change: (settings: JevSettings) => void) => { const settings = defaultJevSettings(); change(settings); return settings; };
const generation = (evidenceIds: string[]) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({
  text: "課題を小さく分けることが強みです。", answerability: "answerable", evidenceIds }) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
// 選別の質問（Choice/Score/Noul）へ、型どおりの答えを返す。
const scopeAnswers = (questions: Record<string, any>, candidateIds: string[], overrides: {
  answerScope?: string; role?: string; support?: number; confidence?: number; noul?: Partial<Record<JevScopeNoulAxis, number>> } = {}) =>
  Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    if (question.type === "choice") {
      const value = id === "answer_scope" ? overrides.answerScope ?? "answerable"
        : id === "evidence_role" ? overrides.role ?? "direct"
          : id === "primary_evidence" ? candidateIds[0] ?? "none_of_the_above" : Object.keys(question.criteria)[0];
      return [id, { type: "choice", choice: value, confidence: overrides.confidence ?? .9 }];
    }
    if (question.type === "score") return [id, { type: "score", score: overrides.support ?? 3, confidence: overrides.confidence ?? .9 }];
    return [id, { type: "noul", noul: overrides.noul?.[id as JevScopeNoulAxis] ?? .95 }];
  }));
// 回答の点検（6軸のNoul）へ、聞かれた軸だけを返す。
const answerScores = (questions: Record<string, any>, overrides: Partial<JevScores> = {}) =>
  Object.fromEntries(Object.keys(questions).map(axis => [axis, { type: "noul", noul: overrides[axis as JevAxis] ?? .95 }]));

test("採点に設定を当て、必須・任意・記録のみを分けて採否を決める", () => {
  assert.equal(jevVerdict(scores(), defaultJevSettings()).accepted, true);
  const strict = jevVerdict(scores({ no_scope_expansion: .7 }), defaultJevSettings());
  assert.equal(strict.accepted, false); assert.deepEqual(strict.requiredFailed, ["no_scope_expansion"]); assert.equal(strict.reason, "required");
  assert.equal(jevVerdict(scores({ claims_supported: .8 }), defaultJevSettings()).accepted, true, "閾値と同じスコアは合格");
  const relaxed = settingsWith(settings => {
    settings.axes.no_invented_causality = { threshold: .5, treatment: "required" };
    settings.axes.claims_supported = { threshold: .5, treatment: "optional" };
    settings.axes.no_scope_expansion = { threshold: .5, treatment: "optional" };
    for (const axis of ["target_match", "aspect_match", "no_unnecessary_abstention"] as const) settings.axes[axis].treatment = "record";
    settings.optionalFailureLimit = 2;
  });
  assert.equal(jevVerdict(scores({ claims_supported: .1 }), relaxed).accepted, true, "任意1件だけの不合格は合格");
  const two = jevVerdict(scores({ claims_supported: .1, no_scope_expansion: .1 }), relaxed);
  assert.equal(two.accepted, false); assert.equal(two.reason, "optional"); assert.deepEqual(two.optionalFailed, ["claims_supported", "no_scope_expansion"]);
  assert.equal(jevVerdict(scores({ no_invented_causality: .4 }), relaxed).accepted, false);
  assert.equal(jevVerdict(scores({ target_match: 0, aspect_match: 0 }), relaxed).accepted, true, "記録のみの軸は採否に効かない");
  relaxed.optionalFailureLimit = 0;
  assert.equal(jevVerdict(scores({ claims_supported: 0, no_scope_expansion: 0 }), relaxed).accepted, true);
});

test("評価しなかった軸は採否に使わない", () => {
  const evaluated: JevAxis[] = ["target_match", "claims_supported", "no_invented_causality"];
  // 評価していない軸が0点でも、必須の不合格にはしない。
  const verdict = jevVerdict({ target_match: .9, claims_supported: .9, no_invented_causality: .9 }, defaultJevSettings(), evaluated);
  assert.equal(verdict.accepted, true);
  assert.deepEqual(verdict.unevaluated, ["aspect_match", "no_scope_expansion", "no_unnecessary_abstention"]);
  const failed = jevVerdict({ target_match: .9, claims_supported: .1 }, defaultJevSettings(), evaluated);
  assert.equal(failed.accepted, false); assert.deepEqual(failed.failedAxes, ["claims_supported"]);
});

test("採点設定は範囲外・未知の項目を保存前に拒否する", () => {
  const base = defaultJevSettings();
  assert.deepEqual(parseJevSettings(base), base);
  const mutate = (change: (settings: Record<string, any>) => void) => {
    const value = JSON.parse(JSON.stringify(base)) as Record<string, any>; change(value); return value;
  };
  for (const value of [
    mutate(settings => { settings.axes.target_match.threshold = 1.01; }),
    mutate(settings => { settings.axes.target_match.threshold = "0.5"; }),
    mutate(settings => { settings.axes.target_match.treatment = "ignore"; }),
    mutate(settings => { delete settings.axes.claims_supported; }),
    mutate(settings => { settings.axes.unknown_axis = { threshold: .5, treatment: "required" }; }),
    mutate(settings => { settings.optionalFailureLimit = 7; }),
    mutate(settings => { settings.limits.maxSerialStages = 4; }),
    mutate(settings => { settings.limits.maxJudgmentsPerStage = 11; }),
    mutate(settings => { settings.limits.maxRepairs = 2; }),
    mutate(settings => { settings.limits.unknown_limit = 1; }),
    mutate(settings => { settings.budgets.answerMs = 1_000; }),
    mutate(settings => { settings.extra = true; }),
    // 生成前の選別の設定。
    mutate(settings => { settings.scope.enabled = "yes"; }),
    mutate(settings => { settings.scope.maxQuestions = 0; }),
    mutate(settings => { settings.scope.maxQuestions = 11; }),
    mutate(settings => { settings.scope.thresholds.direct_support = 1.2; }),
    mutate(settings => { delete settings.scope.thresholds.causal_support; }),
    mutate(settings => { settings.scope.thresholds.subject_clear = .5; }),
    mutate(settings => { settings.scope.supportThreshold = -0.1; }),
    mutate(settings => { settings.scope.confidenceThreshold = 2; }),
    mutate(settings => { settings.scope.lowConfidenceAction = "maybe"; }),
    mutate(settings => { settings.scope.extra = true; }),
    {}
  ]) assert.throws(() => parseJevSettings(value), /invalid_jev/, JSON.stringify(value));
  // 実装が対応する上限そのものは保存できる。
  const maxed = mutate(settings => { settings.optionalFailureLimit = 6; settings.scope.maxQuestions = jevScopeOrder.length; });
  assert.equal(parseJevSettings(maxed).limits.maxSerialStages, 3);
  // 以前に保存した版（scopeが無い）は既定で補う。
  const previous: Record<string, unknown> = JSON.parse(JSON.stringify(base));
  delete previous.scope;
  assert.deepEqual(parseJevSettings(previous).scope, base.scope);
});

test("初期値は現行の採点と、記録だけの安全な選別設定を表す", () => {
  const settings = defaultJevSettings({});
  for (const axis of jevQuestionIds) {
    assert.equal(settings.axes[axis].treatment, "required");
    assert.equal(settings.axes[axis].threshold, defaultJevThresholds[axis]);
  }
  assert.equal(settings.optionalFailureLimit, 0);
  assert.deepEqual(settings.limits, { maxSerialStages: 3, maxJudgmentsPerStage: 10, maxRepairs: 1 });
  assert.deepEqual(settings.budgets, { answerMs: 60_000, jevMs: 4_000 });
  assert.equal(settings.scope.enabled, true);
  assert.equal(settings.scope.maxQuestions, jevScopeOrder.length);
  assert.equal(settings.scope.lowConfidenceAction, "proceed", "既定では低確信でも判定をそのまま使う");
  assert.equal(settings.scope.confidenceThreshold, .5);
  assert.equal(settings.judge.backend, "official", "既定は公式HTTP");
  assert.deepEqual(settings.scope.screening, { enabled: false, candidateThreshold: 12, keep: 6 });
  for (const axis of jevScopeNoulIds) assert.equal(settings.scope.thresholds[axis], axis === "conflict_risk" ? .8 : .6);
  assert.equal(defaultJevSettings({ JEV_THRESHOLDS_JSON: '{"target_match":0.5}' }).axes.target_match.threshold, .5);
  assert.throws(() => defaultJevSettings({ JEV_THRESHOLDS_JSON: '{"target_match":0}' }), /invalid_jev_thresholds/);
  assert.throws(() => defaultJevSettings({ JEV_TIMEOUT_MS: "10" }), /invalid_answer_timeout/);
});

const scopeAssessment = (overrides: {
  answerScope?: string; role?: string; primary?: string; support?: number; confidence?: number;
  noul?: Partial<Record<JevScopeNoulAxis, number>>; skip?: string[] } = {}) => {
  const noul: Record<string, number> = { target_match: .97, time_match: .97, direct_support: .97,
    background_support: .97, causal_support: .97, conflict_risk: .05, ...overrides.noul };
  const answers: Record<string, ParsedAnswer> = {
    answer_scope: { type: "choice", choice: overrides.answerScope ?? "answerable", confidence: overrides.confidence ?? .9 },
    evidence_role: { type: "choice", choice: overrides.role ?? "direct", confidence: overrides.confidence ?? .9 },
    primary_evidence: { type: "choice", choice: overrides.primary ?? "none_of_the_above", confidence: overrides.confidence ?? .9 },
    support_strength: { type: "score", score: Math.round((overrides.support ?? .75) * 3), levels: 4, confidence: overrides.confidence ?? .9 },
    ...Object.fromEntries(Object.entries(noul).map(([id, value]) => [id, { type: "noul" as const, value }]))
  };
  for (const id of overrides.skip ?? []) delete answers[id];
  return { answers, asked: Object.keys(answers) };
};

test("生成前の選別は、Choice・Score・Noulを合成して回答可能範囲と限定を作る", () => {
  const settings = defaultJevSettings();
  const candidates = ["rev_a:0", "rev_b:1"];
  const direct = jevScopeDecision("仕事の進め方は？", scopeAssessment({ primary: "rev_a:0" }), settings, candidates);
  assert.equal(direct.answerability, "answerable");
  assert.equal(direct.primaryEvidenceId, "rev_a:0");
  assert.ok(scopeDirective(direct).includes("直接の根拠"));
  assert.ok(scopeDirective(direct).includes("rev_a:0"), "主な根拠を生成へ伝える");
  assert.ok(scopeDirective(direct).includes("支持は強い"));
  // 答えられる範囲はChoiceが決める。Noulの直接支持が高くても、Choiceがinsufficientなら不明として扱う。
  const insufficient = jevScopeDecision("仕事の進め方は？", scopeAssessment({ answerScope: "insufficient" }), settings, candidates);
  assert.equal(insufficient.answerability, "unclear");
  const ambiguous = jevScopeDecision("仕事の進め方は？", scopeAssessment({ answerScope: "ambiguous" }), settings, candidates);
  assert.equal(ambiguous.answerability, "unclear"); assert.equal(ambiguous.needsSubjectClarification, true);
  assert.ok(scopeDirective(ambiguous).includes("どの対象かを確認"));
  // 役割が background なら背景として答えさせる。
  const background = jevScopeDecision("仕事の進め方は？", scopeAssessment({ answerScope: "partial", role: "background" }), settings, candidates);
  assert.equal(background.answerability, "partial"); assert.equal(background.backgroundOnly, true);
  assert.ok(scopeDirective(background).includes("背景の説明"));
  // 候補集合の外を主根拠として返した場合は採用しない。
  const outside = jevScopeDecision("仕事の進め方は？", scopeAssessment({ primary: "rev_outside:9" }), settings, candidates);
  assert.equal(outside.primaryEvidenceId, null); assert.equal(outside.rejectedPrimary, "rev_outside:9");
  // 由来を尋ねていて、因果が閾値未満なら未確認と限定する。
  assert.equal(asksForOrigin("読書が好きになったきっかけは？"), true);
  const origin = jevScopeDecision("読書が好きになったきっかけは？", scopeAssessment({ noul: { causal_support: .2 } }), settings, candidates);
  assert.equal(origin.causalityUnconfirmed, true);
  assert.ok(scopeDirective(origin).includes("未確認と限定"));
  // 由来を尋ねていなくても、資料に因果が無ければ断定させない。
  assert.equal(jevScopeDecision("仕事の進め方は？", scopeAssessment({ noul: { causal_support: .2 } }), settings, candidates).causalityUnconfirmed, true);
  assert.equal(jevScopeDecision("仕事の進め方は？", scopeAssessment({ noul: { causal_support: .97 } }), settings, candidates).causalityUnconfirmed, false);
  // 矛盾・無関係の軸。
  const messy = jevScopeDecision("仕事の進め方は？", scopeAssessment({ role: "conflict", noul: { conflict_risk: .95 } }), settings, candidates);
  assert.equal(messy.contradiction, true); assert.ok(scopeDirective(messy).includes("一致しない記述"));
  const offTopic = jevScopeDecision("仕事の進め方は？", scopeAssessment({ role: "irrelevant", answerScope: "insufficient" }), settings, candidates);
  assert.equal(offTopic.offTopic, true); assert.ok(scopeDirective(offTopic).includes("無関係"));
  // 支持が弱い場合は言い過ぎない指示を足す。
  assert.ok(scopeDirective(jevScopeDecision("仕事の進め方は？", scopeAssessment({ support: .1 }), settings, candidates)).includes("支持は弱い"));
  // 質問していない軸は判定に使わない。
  const skipped = jevScopeDecision("仕事の進め方は？", scopeAssessment({ skip: ["direct_support", "causal_support"] }), settings, candidates);
  assert.equal(skipped.causalityUnconfirmed, false);
});

test("確信度が低いときは、設定した行き先へ写す", () => {
  const settings = defaultJevSettings();
  const low = jevScopeDecision("仕事の進め方は？", scopeAssessment({ confidence: .2 }), settings, []);
  assert.equal(low.lowConfidence, true); assert.equal(low.confidence, .2);
  assert.equal(jevScopeDecision("仕事の進め方は？", scopeAssessment({ confidence: .8 }), settings, []).lowConfidence, false);
  const softened = softenForLowConfidence(low);
  assert.equal(softened.answerability, "partial");
  assert.ok(scopeDirective(softened).includes("確信が低い"));
  assert.equal(softenForLowConfidence({ ...low, answerability: "partial" }).answerability, "unclear");
});

test("段階数と修復回数が、実際の実行上限を決める", () => {
  const settings = defaultJevSettings();
  // 前段あり・3段階 → 修復は1回。
  assert.equal(stageBudget(settings, 1), 1);
  // 前段なし・3段階 → 修復は1回。
  assert.equal(stageBudget(settings, 0), 1);
  // 段階数2 → 前段＋点検で使い切り、修復しない。
  assert.equal(stageBudget({ ...settings, limits: { ...settings.limits, maxSerialStages: 2 } }, 1), 0);
  assert.equal(stageBudget({ ...settings, limits: { ...settings.limits, maxSerialStages: 2 } }, 0), 1);
  // 2段目を使った場合は、その分だけ修復できない。
  assert.equal(stageBudget(settings, 2), 0);
  // 修復回数を0にすれば、段階に余裕があっても修復しない。
  assert.equal(stageBudget({ ...settings, limits: { ...settings.limits, maxRepairs: 0 } }, 1), 0);
});

test("設定は版つきで保存され、直前の版へ戻せ、壊れた保存値は既定へ戻す", async () => {
  const db = new LocalDatabase();
  const store = new JevSettingsStore(db, "owner");
  const defaults = defaultJevSettings();
  const before = await resolveJevSettings(store, defaults);
  assert.equal(before.version, null); assert.deepEqual(before.settings, defaults);
  const relaxed = settingsWith(settings => { settings.axes.no_scope_expansion.treatment = "optional"; settings.optionalFailureLimit = 2; });
  assert.equal(await store.save(relaxed), 1);
  assert.equal(await store.save(defaults), 2);
  const state = await store.state();
  assert.equal(state.current?.version, 2);
  assert.equal(state.previous?.settings?.axes.no_scope_expansion.treatment, "optional");
  assert.equal(await store.revertPrevious(), 3);
  await db.prepare("UPDATE jev_settings_versions SET settings_json=? WHERE owner_id=? AND version=?").bind('{"axes":{}}', "owner", 3).run();
  const broken = await resolveJevSettings(store, defaults);
  assert.equal(broken.fallback, "stored_settings_invalid"); assert.deepEqual(broken.settings, defaults);
  db.close();
});

test("実行時の採点と段階時間の控えを残し、直近だけを読める", async () => {
  const db = new LocalDatabase();
  const at = (minutes: number) => new Date(Date.UTC(2026, 8, 19, 10, minutes)).toISOString();
  const noul = Object.fromEntries(jevScopeNoulIds.map(axis => [axis, .9]));
  await recordScoreSample(db, "owner", { createdAt: at(1), settingsVersion: 2, kind: "answer", scores: scores() });
  await recordScoreSample(db, "owner", { createdAt: at(2), settingsVersion: 2, kind: "scope", scores: noul });
  // 欠けている採点は控えに残さない。
  await recordScoreSample(db, "owner", { createdAt: at(3), settingsVersion: 2, kind: "scope", scores: { target_match: .5 } });
  const samples = await scoreSamples(db, "owner");
  assert.deepEqual(samples.map(sample => sample.kind), ["scope", "answer"]);
  for (let index = 0; index < 12; index++) {
    await recordScoreSample(db, "owner", { createdAt: at(10 + index), settingsVersion: 3, kind: "answer", scores: scores() });
  }
  assert.equal((await scoreSamples(db, "owner")).length, 10);
  // 段階ごとの時間。p50/p95と件数を返す。
  for (const ms of [100, 200, 300, 400, 500, 600, 700, 800, 900, 1_000]) await recordStageTiming(db, "owner", "judge", ms);
  await recordStageTiming(db, "owner", "generation", 1_000);
  await recordStageTiming(db, "owner", "generation", 2_000);
  await recordStageTiming(db, "owner", "repair", 3_000);
  const metrics = await stageMetrics(db, "owner");
  const judge = metrics.find(metric => metric.stage === "judge")!;
  assert.equal(judge.count, 10); assert.equal(judge.p50, 500); assert.equal(judge.p95, 1_000);
  assert.equal(metrics.find(metric => metric.stage === "generation")!.count, 2);
  assert.equal(metrics.find(metric => metric.stage === "repair")!.p50, 3_000);
  db.close();
});

test("管理操作はサーバー側の鍵で認証し、鍵が無ければ開かない", () => {
  const token = "t".repeat(48);
  const allowed = (value?: string, env: { ADMIN_TOKEN?: string } = { ADMIN_TOKEN: token }) =>
    adminAllowed(new Request("https://app.example/api/admin/jev-settings", value === undefined ? {} : { headers: { "x-mendan-admin": value } }), env);
  assert.equal(allowed(token), true);
  assert.equal(allowed(), false);
  assert.equal(allowed("x".repeat(48)), false);
  assert.equal(allowed(token, {}), false);
  assert.equal(allowed(token, { ADMIN_TOKEN: "short" }), false);
});

const contextKey = Symbol.for("__cloudflare-context__");
const context = globalThis as unknown as Record<symbol, unknown>;
const adminToken = "a".repeat(48);
const adminRequest = (method: "GET" | "POST", body?: unknown, token = adminToken) => new Request("https://app.example/api/admin/jev-settings", {
  method, headers: { Origin: "https://app.example", "x-mendan-admin": token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
const ask = async (message: string) => (await (await chat(new Request("https://app.example/api/chat", { method: "POST",
  headers: { "Content-Type": "application/json", Origin: "https://app.example" },
  body: JSON.stringify({ mode: "meeting_text", message, history: [] }) }))).text())
  .split("\n\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));

test("未認証の読み書きを拒否し、認証後は保存・復元できる", async t => {
  const data = await jevBindings(); context[contextKey] = { env: data.env };
  t.after(() => { data.db.close(); delete context[contextKey]; });
  data.env.ADMIN_TOKEN = adminToken;
  const wrong = "b".repeat(48);
  assert.equal((await adminGet(adminRequest("GET", undefined, wrong))).status, 403);
  assert.equal((await adminPost(adminRequest("POST", { action: "save" }, wrong))).status, 403);
  assert.equal(await new JevSettingsStore(data.db, data.env.OWNER_ID!).latestVersion(), null, "拒否した要求は書き込まない");
  const initial = await (await adminGet(adminRequest("GET"))).json() as any;
  assert.equal(initial.current, null);
  assert.equal(initial.defaults.limits.maxSerialStages, 3);
  assert.equal(initial.defaults.scope.lowConfidenceAction, "proceed");
  assert.deepEqual(initial.samples, []); assert.deepEqual(initial.metrics, []);
  const relaxed = { ...initial.defaults, optionalFailureLimit: 2,
    scope: { ...initial.defaults.scope, confidenceThreshold: .7, lowConfidenceAction: "partial" },
    axes: { ...initial.defaults.axes, no_scope_expansion: { threshold: .5, treatment: "optional" } } };
  const saved = await (await adminPost(adminRequest("POST", { action: "save", settings: relaxed }))).json() as any;
  assert.equal(saved.current.version, 1);
  assert.equal(saved.current.settings.scope.lowConfidenceAction, "partial");
  const refused = await adminPost(adminRequest("POST", { action: "save",
    settings: { ...relaxed, scope: { ...relaxed.scope, confidenceThreshold: 3 } } }));
  assert.equal(refused.status, 400);
  assert.equal(((await refused.json()) as any).error.code, "invalid_jev_confidence");
  await adminPost(adminRequest("POST", { action: "resetDefaults" }));
  const back = await (await adminPost(adminRequest("POST", { action: "revertPrevious" }))).json() as any;
  assert.equal(back.current.settings.scope.lowConfidenceAction, "partial");
  assert.equal(back.current.version, 3);
});

test("保存した設定が次の質問の採否に反映され、設定上合格なら全文修復へ進まない", async t => {
  const data = await jevBindings(); context[contextKey] = { env: data.env };
  t.after(() => { data.db.close(); delete context[contextKey]; });
  data.env.ADMIN_TOKEN = adminToken;
  let generations = 0;
  const low: Partial<JevScores> = { claims_supported: .1, no_scope_expansion: .1 };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (url.includes("opencode.ai")) {
      generations++;
      const input = JSON.parse(body.messages.at(-1).content);
      assert.ok(typeof input.answerPlan?.directive === "string" && input.answerPlan.directive.length > 0, "選別の指示を生成へ渡す");
      assert.equal(typeof input.answerPlan.answerability, "string", "回答可能範囲を構造化して渡す");
      return generation(input.evidence.map((e: any) => e.id));
    }
    if (url.includes("api.typesafe.ai")) {
      if ("answer_scope" in (body.questions as Record<string, unknown>))
        return Response.json({ answers: scopeAnswers(body.questions, [], {}) });
      return Response.json({ answers: answerScores(body.questions, low) });
    }
    throw new Error("unexpected_destination");
  });
  const strict = await ask("強みは？");
  assert.ok(strict.some((event: any) => event.type === "error" && event.code === "ANSWER_REJECTED"));
  assert.equal(generations, 2, "初期値（全軸必須）では修復を1回試みる");
  const initial = await (await adminGet(adminRequest("GET"))).json() as any;
  const relaxed = { ...initial.defaults, optionalFailureLimit: 3,
    axes: { ...initial.defaults.axes, claims_supported: { threshold: .5, treatment: "optional" },
      no_scope_expansion: { threshold: .5, treatment: "optional" } } };
  await adminPost(adminRequest("POST", { action: "save", settings: relaxed }));
  const accepted = await ask("強みは？");
  assert.ok(accepted.some((event: any) => event.type === "text"), "設定上合格なら本文を返す");
  assert.equal(generations, 3, "不要な修復を行わない");
  await adminPost(adminRequest("POST", { action: "save", settings: { ...relaxed, optionalFailureLimit: 2 } }));
  const rejected = await ask("強みは？");
  assert.ok(rejected.some((event: any) => event.type === "error" && event.code === "ANSWER_REJECTED"));
  assert.equal(generations, 5);
});

test("段階数と判定数の上限が実動作に効く", async t => {
  const data = await jevBindings(); context[contextKey] = { env: data.env };
  t.after(() => { data.db.close(); delete context[contextKey]; });
  data.env.ADMIN_TOKEN = adminToken;
  const asked: string[][] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (url.includes("opencode.ai")) {
      const input = JSON.parse(body.messages.at(-1).content);
      return generation(input.evidence.map((e: any) => e.id));
    }
    if (url.includes("api.typesafe.ai")) {
      asked.push(Object.keys(body.questions as Record<string, unknown>));
      if ("answer_scope" in (body.questions as Record<string, unknown>)) return Response.json({ answers: scopeAnswers(body.questions, []) });
      // 点検は3軸だけ聞かれ、その範囲では合格する。
      return Response.json({ answers: answerScores(body.questions, {}) });
    }
    throw new Error("unexpected_destination");
  });
  const initial = await (await adminGet(adminRequest("GET"))).json() as any;
  // 点検を3軸に絞り、選別も4件にする。
  const saved = await adminPost(adminRequest("POST", { action: "save", settings: { ...initial.defaults,
    limits: { ...initial.defaults.limits, maxJudgmentsPerStage: 3, maxSerialStages: 2 },
    scope: { ...initial.defaults.scope, maxQuestions: 4 } } }));
  assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
  const events = await ask("強みは？");
  assert.ok(events.some((event: any) => event.type === "text"));
  // 段階内の判定数（3）が、前段のmaxQuestions（4）より小さいため3件になる。
  assert.deepEqual(asked[0].length, 3, "選別は段階内の判定数までしか聞かない");
  assert.equal(asked.length, 2, "maxSerialStages=2では前段と点検の2回で終わる");
  assert.deepEqual(asked[1], ["target_match", "aspect_match", "claims_supported"], "点検は上限の軸数だけ聞く");
});

test("低確信の行き先が hold のときは、未検証の本文を出さず保留を案内する", async t => {
  const data = await jevBindings(); context[contextKey] = { env: data.env };
  t.after(() => { data.db.close(); delete context[contextKey]; });
  data.env.ADMIN_TOKEN = adminToken;
  let generations = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (url.includes("opencode.ai")) { generations++; const input = JSON.parse(body.messages.at(-1).content);
      return generation(input.evidence.map((e: any) => e.id)); }
    if (url.includes("api.typesafe.ai")) return Response.json({ answers: scopeAnswers(body.questions, [], { confidence: .1 }) });
    throw new Error("unexpected_destination");
  });
  const initial = await (await adminGet(adminRequest("GET"))).json() as any;
  await adminPost(adminRequest("POST", { action: "save", settings: { ...initial.defaults,
    scope: { ...initial.defaults.scope, confidenceThreshold: .8, lowConfidenceAction: "hold" } } }));
  const events = await ask("強みは？");
  assert.equal(generations, 0, "保留では生成も点検も行わない");
  assert.ok(events.some((event: any) => event.type === "text" && /確認できていません/.test(event.text)));
  assert.ok(events.some((event: any) => event.type === "done" && event.answerability === "unknown"));
});

test("低確信の行き先が second-stage のときは、もう1段階だけ聞き直す", async t => {
  const data = await jevBindings(); context[contextKey] = { env: data.env };
  t.after(() => { data.db.close(); delete context[contextKey]; });
  data.env.ADMIN_TOKEN = adminToken;
  const asked: string[][] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (url.includes("opencode.ai")) { const input = JSON.parse(body.messages.at(-1).content); return generation(input.evidence.map((e: any) => e.id)); }
    if (url.includes("api.typesafe.ai")) {
      if ("answer_scope" in (body.questions as Record<string, unknown>)) {
        const tieBreak = JSON.stringify(body.state).includes("確信が得られなかった");
        asked.push([tieBreak ? "tie-break" : "first"]);
        return Response.json({ answers: scopeAnswers(body.questions, [], { confidence: tieBreak ? .9 : .1 }) });
      }
      return Response.json({ answers: answerScores(body.questions, {}) });
    }
    throw new Error("unexpected_destination");
  });
  const initial = await (await adminGet(adminRequest("GET"))).json() as any;
  await adminPost(adminRequest("POST", { action: "save", settings: { ...initial.defaults,
    scope: { ...initial.defaults.scope, confidenceThreshold: .8, lowConfidenceAction: "second-stage" } } }));
  const events = await ask("強みは？");
  assert.deepEqual(asked, [["first"], ["tie-break"]], "低確信のときだけ2段目を聞く");
  assert.ok(events.some((event: any) => event.type === "text"));
  const trace = events.find((event: any) => event.type === "trace")?.trace ?? [];
  assert.ok(trace.some((entry: any) => entry.code === "scope_low_confidence" && entry.reason === "second-stage"));
  assert.equal(trace.filter((entry: any) => entry.code === "scope_attempt").length, 2);
});

test("JEVの障害は、閾値を下げても合格にしない", async t => {
  const data = await jevBindings(); context[contextKey] = { env: data.env };
  t.after(() => { data.db.close(); delete context[contextKey]; });
  data.env.ADMIN_TOKEN = adminToken;
  await adminPost(adminRequest("POST", { action: "save", settings: { ...defaultJevSettings(), optionalFailureLimit: 6,
    axes: Object.fromEntries(jevQuestionIds.map(axis => [axis, { threshold: 0, treatment: "record" }])) } }));
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (url.includes("opencode.ai")) { const input = JSON.parse(body.messages.at(-1).content); return generation(input.evidence.map((e: any) => e.id)); }
    if (url.includes("api.typesafe.ai")) {
      if ("answer_scope" in (body.questions as Record<string, unknown>)) return Response.json({ answers: scopeAnswers(body.questions, []) });
      return new Response("private diagnostic", { status: 503 });
    }
    throw new Error("unexpected_destination");
  });
  const events = await ask("強みは？");
  assert.ok(events.some((event: any) => event.type === "error" && event.code === "JEV_UNAVAILABLE"));
});

test("実行記録に、採点の控えと段階ごとの時間が残る", async t => {
  const data = await jevBindings(); context[contextKey] = { env: data.env };
  t.after(() => { data.db.close(); delete context[contextKey]; });
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (url.includes("opencode.ai")) { const input = JSON.parse(body.messages.at(-1).content); return generation(input.evidence.map((e: any) => e.id)); }
    if (url.includes("api.typesafe.ai")) {
      if ("answer_scope" in (body.questions as Record<string, unknown>)) return Response.json({ answers: scopeAnswers(body.questions, []) });
      return Response.json({ answers: answerScores(body.questions, {}) });
    }
    throw new Error("unexpected_destination");
  });
  await ask("強みは？");
  const owner = data.env.OWNER_ID!;
  let samples = await scoreSamples(data.db, owner);
  for (let attempt = 0; attempt < 40 && samples.length < 2; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25));
    samples = await scoreSamples(data.db, owner);
  }
  assert.deepEqual([...new Set(samples.map(sample => sample.kind))].sort(), ["answer", "scope"]);
  assert.equal(samples.find(sample => sample.kind === "scope")!.scores.direct_support, .95);
  const metrics = await stageMetrics(data.db, owner);
  assert.deepEqual([...new Set(metrics.map(metric => metric.stage))].sort(), ["generation", "judge", "scope"]);
  assert.ok(metrics.every(metric => metric.count >= 1 && metric.p50 >= 0 && metric.p95 >= metric.p50));
});

test("判定の呼び出し先と絞り込みの設定を検査する", () => {
  const base = defaultJevSettings();
  const mutate = (change: (settings: Record<string, any>) => void) => {
    const value = JSON.parse(JSON.stringify(base)) as Record<string, any>; change(value); return value;
  };
  assert.equal(parseJevSettings(mutate(settings => { settings.judge.backend = "workers-ai"; })).judge.backend, "workers-ai");
  assert.equal(parseJevSettings(mutate(settings => { settings.scope.screening.enabled = true; settings.scope.screening.keep = 4; }))
    .scope.screening.keep, 4);
  for (const value of [
    mutate(settings => { settings.judge.backend = "http"; }),
    mutate(settings => { settings.judge.extra = true; }),
    mutate(settings => { settings.scope.screening.enabled = "yes"; }),
    mutate(settings => { settings.scope.screening.candidateThreshold = 1; }),
    mutate(settings => { settings.scope.screening.keep = 11; }),
    mutate(settings => { settings.scope.screening.extra = true; })
  ]) assert.throws(() => parseJevSettings(value), /invalid_jev/, JSON.stringify(value));
});

test("Workers AIのJEVは同じstate/questionsを送り、resultの包みを外して読む", async () => {
  const evidence = [{ id: "rev_a:0", kind: "chunk" as const, title: "見出し", revisionId: "rev_a", documentId: "doc", ownerId: "o",
    text: "本文です。", content: "本文です。", contentHash: "hash", rank: 1, facts: [], entities: [] }];
  const calls: { model: string; input: any }[] = [];
  const ai = { async run(model: string, input: any) {
    calls.push({ model, input });
    const answers = Object.fromEntries(Object.entries(input.questions as Record<string, any>).map(([id, question]) => [id,
      question.type === "choice" ? { type: "choice", choice: Object.keys(question.criteria)[0], probabilities: { partial: .6, answerable: .3 }, confidence: .4 }
        : question.type === "score" ? { type: "score", score: 2, confidence: .5 } : { type: "noul", noul: .42 }]));
    return { result: { answers, usage: { input_tokens: 11, output_tokens: 3 } } };
  } };
  const judge = new WorkersAiJev(ai as any);
  const scope = await judge.checkScope({ question: "質問ですか？", history: [], evidence, maxJudgments: 2 }, new AbortController().signal);
  assert.equal(calls[0].model, "typesafe/jev");
  assert.equal(typeof calls[0].input.state, "object", "stateは構造化JSONで渡す");
  assert.equal(calls[0].input.state.candidate_evidence[0].id, "rev_a:0");
  assert.deepEqual(scope.asked, ["answer_scope", "direct_support"]);
  assert.deepEqual(scope.answers.answer_scope, { type: "choice", choice: "answerable", probabilities: { partial: .6, answerable: .3 }, confidence: .4 });
  assert.equal(scope.usage?.input, 11);
  // 絞り込みは候補IDごとのScoreを返す。
  const screening = await judge.screenCandidates({ question: "質問ですか？", history: [], evidence, limit: 1 }, new AbortController().signal);
  assert.deepEqual(Object.keys(screening), ["rev_a:0"]);
  assert.equal(screening["rev_a:0"], 2 / 3, "段階値を0〜1へ写す");
  // 形が違う応答は受け付けない。
  const broken = new WorkersAiJev({ async run() { return { result: { answers: {} } }; } } as any);
  await assert.rejects(broken.checkScope({ question: "質問", history: [], evidence, maxJudgments: 1 }, new AbortController().signal), /invalid_jev_response/);
});

test("比較用のエンドポイントは、鍵が無ければ拒否し、架空の資料だけで両バックエンドを測る", async t => {
  const data = await jevBindings(); context[contextKey] = { env: data.env };
  t.after(() => { data.db.close(); delete context[contextKey]; });
  data.env.ADMIN_TOKEN = adminToken;
  const probe = (body?: unknown, token = adminToken) => new Request("https://app.example/api/admin/jev-probe", { method: "POST",
    headers: { Origin: "https://app.example", "x-mendan-admin": token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await probePost(probe({ runs: 1 }, "b".repeat(48)))).status, 403);
  assert.equal((await probePost(probe({ runs: 9 }))).status, 400);
  const seen: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    seen.push(String(url));
    const body = JSON.parse(init.body as string);
    return Response.json({ answers: Object.fromEntries(Object.entries(body.questions as Record<string, any>).map(([id, question]) => [id,
      question.type === "choice" ? { type: "choice", choice: Object.keys(question.criteria)[0], confidence: .5 }
        : question.type === "score" ? { type: "score", score: 2, confidence: .5 } : { type: "noul", noul: .5 }])) });
  });
  const response = await probePost(probe({ runs: 1 }));
  assert.equal(response.status, 200);
  const result = await response.json() as any;
  assert.equal(result.results["probe-official"][0].ok, true, JSON.stringify(result.results["probe-official"][0]));
  assert.deepEqual(result.results["probe-official"][0].types, ["choice", "noul", "score"], "Choice・Noul・Scoreを1回で受け取る");
  assert.equal(result.results["probe-official"][0].judgments, 10);
  assert.ok(seen.every(url => url.startsWith("https://api.typesafe.ai")), "既存の送信先だけを使う");
  assert.ok(result.results["probe-workers-ai"], "AI bindingがあればWorkers AI側も測る");
  assert.equal(result.results["probe-workers-ai"][0].ok, false, "模擬の埋め込み用バインディングでは形が合わない");
  assert.equal(JSON.stringify(result).includes("架空の会社"), false, "本文は返さない");
  const metrics = await stageMetrics(data.db, data.env.OWNER_ID!);
  assert.ok(metrics.some(metric => metric.stage === "probe-official"));
});
