import test from "node:test";
import assert from "node:assert/strict";
import { POST as chat } from "../app/api/chat/route.ts";
import { GET as adminGet, POST as adminPost } from "../app/api/admin/jev-settings/route.ts";
import { defaultJevThresholds, jevQuestionIds, type JevScores } from "../lib/ai/jev.ts";
import { asksForOrigin, defaultJevSettings, jevScopeDecision, jevVerdict, parseJevSettings, scopeDirective, type JevSettings } from "../lib/answer/jev-settings.ts";
import { jevScopeIds, type JevScopeScores } from "../lib/ai/jev-scope.ts";
import { JevSettingsStore, recordScoreSample, resolveJevSettings, scoreSamples } from "../lib/answer/jev-settings-store.ts";
import { adminAllowed } from "../lib/security/admin.ts";
import { jevBindings } from "./fixtures/jev.ts";
import { LocalDatabase } from "./helpers.ts";

const scores = (changes: Partial<JevScores> = {}): JevScores =>
  Object.fromEntries(jevQuestionIds.map(axis => [axis, changes[axis] ?? .97])) as JevScores;
const settingsWith = (change: (settings: JevSettings) => void) => { const settings = defaultJevSettings(); change(settings); return settings; };
// 生成モデルの模擬応答。SSEのdataフレームとして返す。
const generation = (evidenceIds: string[]) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({
  text: "課題を小さく分けることが強みです。", answerability: "answerable", evidenceIds }) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);

test("採点に設定を当て、必須・任意・記録のみを分けて採否を決める", () => {
  assert.equal(jevVerdict(scores(), defaultJevSettings()).accepted, true);
  // 初期値は全軸必須。1件の不合格で不採用になる。
  const strict = jevVerdict(scores({ no_scope_expansion: .7 }), defaultJevSettings());
  assert.equal(strict.accepted, false); assert.deepEqual(strict.requiredFailed, ["no_scope_expansion"]); assert.equal(strict.reason, "required");
  // 閾値と同じスコアは合格。
  assert.equal(jevVerdict(scores({ claims_supported: .8 }), defaultJevSettings()).accepted, true);
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
  // 必須の不合格は、他のスコアが満点でも不採用。
  assert.equal(jevVerdict(scores({ no_invented_causality: .4 }), relaxed).accepted, false);
  // 記録のみの軸は0点でも採否に効かない。
  assert.equal(jevVerdict(scores({ target_match: 0, aspect_match: 0 }), relaxed).accepted, true);
  // 0は「任意だけでは不採用にしない」。
  relaxed.optionalFailureLimit = 0;
  assert.equal(jevVerdict(scores({ claims_supported: 0, no_scope_expansion: 0 }), relaxed).accepted, true);
});

test("採点設定は範囲外・未知の項目を保存前に拒否する", () => {
  const base = defaultJevSettings();
  assert.deepEqual(parseJevSettings(base), base);
  const mutate = (change: (settings: Record<string, any>) => void) => {
    const value = JSON.parse(JSON.stringify(base)) as Record<string, any>; change(value); return value;
  };
  for (const value of [
    mutate(settings => { settings.axes.target_match.threshold = 1.01; }),
    mutate(settings => { settings.axes.target_match.threshold = -0.01; }),
    mutate(settings => { settings.axes.target_match.threshold = "0.5"; }),
    mutate(settings => { settings.axes.target_match.treatment = "ignore"; }),
    mutate(settings => { delete settings.axes.claims_supported; }),
    mutate(settings => { settings.axes.unknown_axis = { threshold: .5, treatment: "required" }; }),
    mutate(settings => { settings.optionalFailureLimit = 7; }),
    mutate(settings => { settings.optionalFailureLimit = 1.5; }),
    mutate(settings => { settings.limits.maxSerialStages = 4; }),
    mutate(settings => { settings.limits.maxJudgmentsPerStage = 11; }),
    mutate(settings => { settings.limits.maxRepairs = 2; }),
    mutate(settings => { settings.limits.unknown_limit = 1; }),
    mutate(settings => { settings.budgets.answerMs = 1_000; }),
    mutate(settings => { settings.budgets.jevMs = 60_000; }),
    mutate(settings => { settings.extra = true; }),
    {}
  ]) assert.throws(() => parseJevSettings(value), /invalid_jev/, JSON.stringify(value));
  // 実装が対応する上限そのものは保存できる。
  const maxed = mutate(settings => { settings.optionalFailureLimit = 6; });
  assert.equal(parseJevSettings(maxed).limits.maxSerialStages, 3);
});

const scopeScores = (changes: Partial<JevScopeScores> = {}): JevScopeScores =>
  Object.fromEntries(jevScopeIds.map(axis => [axis, changes[axis] ?? .97])) as JevScopeScores;

test("生成前の選別は、答えられる範囲と限定だけを指示へ写す", () => {
  const settings = defaultJevSettings();
  // 直接の根拠がある。
  const direct = jevScopeDecision("仕事の進め方は？", scopeScores(), settings);
  assert.equal(direct.answerability, "answerable");
  assert.ok(scopeDirective(direct).includes("直接の根拠"));
  // 背景だけで、直接の答えが無い。
  const background = jevScopeDecision("仕事の進め方は？", scopeScores({ direct_evidence: .2 }), settings);
  assert.equal(background.answerability, "partial");
  assert.equal(background.backgroundOnly, true);
  assert.ok(scopeDirective(background).includes("背景の説明"));
  // 由来を尋ねているが、資料に形成原因が明記されていない。
  assert.equal(asksForOrigin("読書が好きになったきっかけは？"), true);
  const origin = jevScopeDecision("読書が好きになったきっかけは？", scopeScores({ causality_documented: .2 }), settings);
  assert.equal(origin.causalityUnconfirmed, true);
  assert.ok(scopeDirective(origin).includes("未確認と限定"));
  assert.equal(jevScopeDecision("仕事の進め方は？", scopeScores({ causality_documented: .2 }), settings).causalityUnconfirmed, false);
  // 矛盾・無関係・対象不明は、それぞれの限定を付ける。
  const messy = jevScopeDecision("仕事の進め方は？", scopeScores({ contradiction: .95, off_topic: .9, subject_clear: .1 }), settings);
  assert.deepEqual([messy.contradiction, messy.offTopic, messy.needsSubjectClarification], [true, true, true]);
  assert.ok(scopeDirective(messy).includes("一致しない記述"));
  assert.ok(scopeDirective(messy).includes("無関係"));
  assert.ok(scopeDirective(messy).includes("どの対象かを確認"));
  // 複数資料で一つの答えになる場合。
  assert.ok(scopeDirective(jevScopeDecision("仕事の進め方は？", scopeScores({ multi_source: .9 }), settings)).includes("複数の資料"));
});

test("生成前の選別の設定も、範囲外・未知の項目を拒否し、旧版は既定で補う", () => {
  const base = defaultJevSettings();
  assert.equal(base.scope.enabled, true);
  assert.equal(base.scope.maxQuestions, jevScopeIds.length);
  // 以前に保存した版（scopeが無い）は、既定で補って読む。
  const previous: Record<string, unknown> = JSON.parse(JSON.stringify(base));
  delete previous.scope;
  assert.deepEqual(parseJevSettings(previous).scope, base.scope);
  const mutate = (change: (settings: Record<string, any>) => void) => {
    const value = JSON.parse(JSON.stringify(base)) as Record<string, any>; change(value); return value;
  };
  for (const value of [
    mutate(settings => { settings.scope.enabled = "yes"; }),
    mutate(settings => { settings.scope.maxQuestions = 0; }),
    mutate(settings => { settings.scope.maxQuestions = 9; }),
    mutate(settings => { settings.scope.thresholds.direct_evidence = 1.2; }),
    mutate(settings => { settings.scope.thresholds.unknown_axis = .5; }),
    mutate(settings => { settings.scope.extra = true; }),
    mutate(settings => { delete settings.scope.thresholds.contradiction; })
  ]) assert.throws(() => parseJevSettings(value), /invalid_jev/, JSON.stringify(value));
});

test("初期値は現行の環境設定をそのまま表す", () => {
  const settings = defaultJevSettings({});
  for (const axis of jevQuestionIds) {
    assert.equal(settings.axes[axis].treatment, "required");
    assert.equal(settings.axes[axis].threshold, defaultJevThresholds[axis]);
  }
  assert.equal(settings.optionalFailureLimit, 0);
  assert.deepEqual(settings.limits, { maxSerialStages: 3, maxJudgmentsPerStage: 10, maxRepairs: 1 });
  assert.deepEqual(settings.budgets, { answerMs: 25_000, jevMs: 4_000 });
  assert.equal(defaultJevSettings({ JEV_THRESHOLDS_JSON: '{"target_match":0.5}' }).axes.target_match.threshold, .5);
  assert.throws(() => defaultJevSettings({ JEV_THRESHOLDS_JSON: '{"target_match":0}' }), /invalid_jev_thresholds/);
  assert.throws(() => defaultJevSettings({ JEV_TIMEOUT_MS: "10" }), /invalid_answer_timeout/);
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
  assert.equal(state.previous?.version, 1);
  assert.equal(state.previous?.settings?.axes.no_scope_expansion.treatment, "optional");
  assert.equal(await store.revertPrevious(), 3);
  assert.equal((await store.state()).current?.settings?.axes.no_scope_expansion.treatment, "optional");
  await db.prepare("UPDATE jev_settings_versions SET settings_json=? WHERE owner_id=? AND version=?").bind('{"axes":{}}', "owner", 3).run();
  const broken = await resolveJevSettings(store, defaults);
  assert.equal(broken.fallback, "stored_settings_invalid"); assert.equal(broken.version, 3); assert.deepEqual(broken.settings, defaults);
  db.close();
});

test("管理操作はサーバー側の鍵で認証し、鍵が無ければ開かない", () => {
  const token = "t".repeat(48);
  const allowed = (value?: string, env: { ADMIN_TOKEN?: string } = { ADMIN_TOKEN: token }) =>
    adminAllowed(new Request("https://app.example/api/admin/jev-settings", value === undefined ? {} : { headers: { "x-mendan-admin": value } }), env);
  assert.equal(allowed(token), true);
  assert.equal(allowed(), false);
  assert.equal(allowed("x".repeat(48)), false);
  assert.equal(allowed("t".repeat(47)), false);
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
  const relaxed = { ...initial.defaults, optionalFailureLimit: 2,
    axes: { ...initial.defaults.axes, no_invented_causality: { threshold: .8, treatment: "required" },
      no_scope_expansion: { threshold: .5, treatment: "optional" } } };
  const saved = await (await adminPost(adminRequest("POST", { action: "save", settings: relaxed }))).json() as any;
  assert.equal(saved.current.version, 1);
  assert.equal(saved.current.settings.axes.no_scope_expansion.treatment, "optional");
  const refused = await adminPost(adminRequest("POST", { action: "save",
    settings: { ...relaxed, limits: { ...relaxed.limits, maxSerialStages: 4 } } }));
  assert.equal(refused.status, 400);
  assert.equal(((await refused.json()) as any).error.code, "invalid_jev_limits");
  await adminPost(adminRequest("POST", { action: "resetDefaults" }));
  const back = await (await adminPost(adminRequest("POST", { action: "revertPrevious" }))).json() as any;
  assert.equal(back.current.settings.axes.no_scope_expansion.treatment, "optional");
  assert.equal(back.current.version, 3);
});

test("保存した設定が次の質問の採否に反映され、設定上合格なら全文修復へ進まない", async t => {
  const data = await jevBindings(); context[contextKey] = { env: data.env };
  t.after(() => { data.db.close(); delete context[contextKey]; });
  data.env.ADMIN_TOKEN = adminToken;
  let generations = 0;
  // 2項目だけを低く採点した応答を返す。
  const low: Partial<JevScores> = { claims_supported: .1, no_scope_expansion: .1 };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (url.includes("opencode.ai")) {
      generations++;
      const input = JSON.parse(body.messages.at(-1).content);
      return generation(input.evidence.map((e: any) => e.id));
    }
    if (url.includes("api.typesafe.ai")) return Response.json({ answers: Object.fromEntries(jevQuestionIds.map(axis =>
      [axis, { type: "noul", noul: low[axis] ?? .97 }])) });
    throw new Error("unexpected_destination");
  });
  const ask = async () => (await (await chat(new Request("https://app.example/api/chat", { method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://app.example" },
    body: JSON.stringify({ mode: "meeting_text", message: "強みは？", history: [] }) }))).text())
    .split("\n\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  // 初期値（全軸必須）では2件の不合格で不採用になり、修復を1回試みる。
  const strict = await ask();
  assert.ok(strict.some((event: any) => event.type === "error" && event.code === "ANSWER_REJECTED"));
  assert.equal(generations, 2);
  // 任意2件合格（上限3）へ変更すると、同じ採点でも回答を返す。
  const initial = await (await adminGet(adminRequest("GET"))).json() as any;
  const relaxed = { ...initial.defaults, optionalFailureLimit: 3,
    axes: { ...initial.defaults.axes, claims_supported: { threshold: .5, treatment: "optional" },
      no_scope_expansion: { threshold: .5, treatment: "optional" } } };
  await adminPost(adminRequest("POST", { action: "save", settings: relaxed }));
  const accepted = await ask();
  assert.ok(accepted.some((event: any) => event.type === "text"), "設定上合格なら本文を返す");
  assert.equal(generations, 3, "不要な修復を行わない");
  // 上限を2へ下げると、同じ採点でも不採用になる。
  await adminPost(adminRequest("POST", { action: "save", settings: { ...relaxed, optionalFailureLimit: 2 } }));
  const rejected = await ask();
  assert.ok(rejected.some((event: any) => event.type === "error" && event.code === "ANSWER_REJECTED"));
  assert.equal(generations, 5);
});

test("JEVの障害は、閾値を下げても合格にしない", async t => {
  const data = await jevBindings(); context[contextKey] = { env: data.env };
  t.after(() => { data.db.close(); delete context[contextKey]; });
  data.env.ADMIN_TOKEN = adminToken;
  await adminPost(adminRequest("POST", { action: "save", settings: { ...defaultJevSettings(), optionalFailureLimit: 6,
    axes: Object.fromEntries(jevQuestionIds.map(axis => [axis, { threshold: 0, treatment: "record" }])) } }));
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (url.includes("opencode.ai")) {
      const input = JSON.parse(body.messages.at(-1).content);
      return generation(input.evidence.map((e: any) => e.id));
    }
    if (url.includes("api.typesafe.ai")) return new Response("private diagnostic", { status: 503 });
    throw new Error("unexpected_destination");
  });
  const events = (await (await chat(new Request("https://app.example/api/chat", { method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://app.example" },
    body: JSON.stringify({ mode: "meeting_text", message: "強みは？", history: [] }) }))).text())
    .split("\n\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  assert.ok(events.some((event: any) => event.type === "error" && event.code === "JEV_UNAVAILABLE"));
});

test("実行時の採点の控えを残し、直近だけを管理画面から読める", async t => {
  const db = new LocalDatabase();
  const at = (minutes: number) => new Date(Date.UTC(2026, 8, 18, 10, minutes)).toISOString();
  await recordScoreSample(db, "owner", { createdAt: at(1), settingsVersion: 2, kind: "answer", scores: scores() });
  await recordScoreSample(db, "owner", { createdAt: at(2), settingsVersion: 2, kind: "scope", scores: scopeScores() });
  // 欠けている採点は控えに残さない。
  await recordScoreSample(db, "owner", { createdAt: at(3), settingsVersion: 2, kind: "scope", scores: { subject_clear: .5 } });
  await recordScoreSample(db, "owner", { createdAt: at(4), settingsVersion: 2, kind: "answer", scores: { ...scores(), claims_supported: 42 } });
  const samples = await scoreSamples(db, "owner");
  assert.equal(samples.length, 2);
  assert.deepEqual(samples.map(sample => sample.kind), ["scope", "answer"], "新しい順に返す");
  assert.equal(samples[1].settingsVersion, 2);
  assert.equal(samples[1].scores.claims_supported, .97);
  // 上限を超えたら古いものから落ちる。
  for (let index = 0; index < 12; index++) {
    await recordScoreSample(db, "owner", { createdAt: at(10 + index), settingsVersion: 3, kind: "answer", scores: scores() });
  }
  assert.equal((await scoreSamples(db, "owner")).length, 10);
  db.close();
});

test("本体APIの実行記録から、採点の控えが残る", async t => {
  const data = await jevBindings(); context[contextKey] = { env: data.env };
  t.after(() => { data.db.close(); delete context[contextKey]; });
  const low: Partial<JevScores> = { no_scope_expansion: .2 };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (url.includes("opencode.ai")) {
      const input = JSON.parse(body.messages.at(-1).content);
      return generation(input.evidence.map((e: any) => e.id));
    }
    if (url.includes("api.typesafe.ai")) {
      const scope = "direct_evidence" in (body.questions as Record<string, unknown>);
      const answers = scope
        ? jevScopeIds.map(axis => [axis, { type: "noul", noul: axis === "contradiction" ? .05 : .95 }])
        : jevQuestionIds.map(axis => [axis, { type: "noul", noul: low[axis] ?? .95 }]);
      return Response.json({ answers: Object.fromEntries(answers) });
    }
    throw new Error("unexpected_destination");
  });
  await chat(new Request("https://app.example/api/chat", { method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://app.example" },
    body: JSON.stringify({ mode: "meeting_text", message: "強みは？", history: [] }) })).then(response => response.text());
  // 控えの書き込みは応答の後でもよいので、少し待つ。
  let samples = await scoreSamples(data.db, data.env.OWNER_ID!);
  for (let attempt = 0; attempt < 40 && samples.length < 2; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25));
    samples = await scoreSamples(data.db, data.env.OWNER_ID!);
  }
  // 修復まで進むと同じ質問でも複数の採点が残る。種別は両方そろう。
  assert.deepEqual([...new Set(samples.map(sample => sample.kind))].sort(), ["answer", "scope"]);
  assert.equal(samples.find(sample => sample.kind === "scope")!.scores.contradiction, .05);
  assert.equal(samples.every(sample => Object.keys(sample.scores).length >= 6), true);
});
