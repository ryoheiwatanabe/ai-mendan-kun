import test from "node:test";
import assert from "node:assert/strict";
import { POST as chat } from "../app/api/chat/route.ts";
import { GET as adminGet, POST as adminPost } from "../app/api/admin/jev-settings/route.ts";
import { defaultJevThresholds, jevQuestionIds, type JevScores } from "../lib/ai/jev.ts";
import { defaultJevSettings, jevVerdict, parseJevSettings, type JevSettings } from "../lib/answer/jev-settings.ts";
import { JevSettingsStore, resolveJevSettings } from "../lib/answer/jev-settings-store.ts";
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
