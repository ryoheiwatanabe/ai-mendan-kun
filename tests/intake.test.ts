import test from "node:test";
import assert from "node:assert/strict";
import { GET as intakeGet, POST as intakePost } from "../app/api/admin/intake/route.ts";
import { intakeBundle, parseIntakeResult } from "../lib/knowledge/intake.ts";
import { approveImport, prepareImport } from "../lib/knowledge/import.ts";
import { KnowledgeRepository } from "../lib/knowledge/repository.ts";
import { getContentExclusions } from "../lib/security/content-exclusions.ts";
import { claimExpiredIntakeDraft, createIntakeDraft, createIntakeSource, updateIntakeCandidate } from "../lib/knowledge/intake-store.ts";
import { jevBindings, jevFixture } from "./fixtures/jev.ts";
import { embedding, setup } from "./helpers.ts";

// 取り込み（#5）の結合確認。原文は管理用にだけ残し、公開用の本文と検索語だけを登録する。
const contextKey = Symbol.for("__cloudflare-context__");
const context = globalThis as unknown as Record<symbol, unknown>;
const adminToken = "a".repeat(48);
const marker = "MKR-83f2a1";
const request = (method: "GET" | "POST", body?: unknown, token = adminToken) => new Request("https://app.example/api/admin/intake", {
  method, headers: { Origin: "https://app.example", "x-mendan-admin": token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
// 原文には、公開したくない順位・感情表現と、漏れを見つけるためのマーカーを入れる。
const rawSource = [
  "【公開しないマーカー " + marker + "】",
  "大事な順: 1位 面白さ / 2位 裁量 / 3位 安定。",
  "「体育会系の上下関係は絶対に嫌」。給与より自由度を取りたい。",
  "仕事では面白さと、自分で考えて動ける裁量を重視している。目的や判断に納得感を持って取り組めることを大切にしている。"
].join("\n");
const candidate = { publicText: "仕事では、面白さと、自分で考えて動ける裁量を重視しています。目的や判断に納得感を持って取り組めることを大切にしています。",
  aliases: ["仕事選びの軸", "裁量", "価値観", "仕事で大切にしていること"], topic: "work_values",
  kept: ["面白さと裁量の重視"], omitted: [{ item: "順位の詳細（1位 面白さ など）", reason: "内部の細かい順位は公開しない" },
    { item: "体育会系への強い否定", reason: "望む働き方の表現へ置き換えた" }],
  questions: [] };
const editedText = "仕事では、面白さと裁量を重視しています。目的や判断に納得感を持って取り組めることを大切にしています。";

const completion = (value: unknown) => Response.json({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 120, completion_tokens: 60 } });
// 取り込み時の意味保持の確認（JEV）へ、聞かれた軸だけ合格で返す。
const judgeReply = (questions: Record<string, unknown>, overrides: Record<string, number> = {}) =>
  Object.fromEntries(Object.keys(questions).map(axis => [axis, { type: "noul", noul: overrides[axis] ?? .95 }]));

async function withEnv(t: test.TestContext) {
  const data = await jevBindings();
  context[contextKey] = { env: data.env };
  t.after(() => { data.db.close(); delete context[contextKey]; });
  data.env.ADMIN_TOKEN = adminToken;
  return data;
}
function mockModel(t: test.TestContext, embedded: string[] = []) {
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const target = String(url);
    if (target.includes("opencode.ai")) return completion(candidate);
    if (target.includes("api.openai.com")) return completion(candidate);
    if (target.includes("api.typesafe.ai")) return Response.json({ answers: judgeReply(JSON.parse(init.body as string).questions) });
    throw new Error("unexpected_destination");
  });
  return embedded;
}

test("原文から公開用候補を作り、本人が編集した公開文だけを検索へ登録する", async t => {
  const data = await withEnv(t);
  mockModel(t);
  // 原文の保存先と送信先への同意がないと、候補づくりを実行しない。
  assert.equal((await intakePost(request("POST", { action: "prepare", title: "仕事で大切にしていること", rawText: rawSource }))).status, 400);
  const prepared = await (await intakePost(request("POST", { action: "prepare", title: "仕事で大切にしていること", rawText: rawSource, acknowledgeStorage: true }))).json() as any;
  assert.equal(prepared.draft.publicText, candidate.publicText, "候補の本文を返す");
  assert.equal(prepared.draft.omitted.length, candidate.omitted.length, "省略した内容と理由は管理用に残す");
  assert.ok(prepared.draft.omitted[0].item.includes("順位の詳細"));
  assert.equal(prepared.draft.omitted[0].reason, candidate.omitted[0].reason);
  assert.ok(prepared.draft.approvalHash, "承認に使うhashを返す");
  assert.deepEqual(prepared.draft.target, { kind: "new" }, "保存済み下書きの公開対象を返す（新規）");
  const before = await data.db.prepare("SELECT COUNT(*) AS count FROM knowledge_document_revisions").first<{ count: number }>();
  assert.equal(Number(before?.count), 1, "候補づくりでは公開しない");

  const saved = await (await intakePost(request("POST", { action: "save", draftId: prepared.draft.id, title: "仕事で大切にしていること",
    publicText: editedText, aliases: ["仕事選びの軸", "裁量"], topic: "work_values" }))).json() as any;
  assert.notEqual(saved.draft.approvalHash, prepared.draft.approvalHash, "編集で承認hashが変わる");
  assert.equal((await intakePost(request("POST", { action: "approve", draftId: prepared.draft.id, approvalHash: prepared.draft.approvalHash,
    version: prepared.draft.version, expectedTarget: { kind: "new" } }))).status, 409, "編集前の古いhashでは登録しない");
  // 別タブで保存された後の古い版では承認しない。
  assert.equal((await intakePost(request("POST", { action: "approve", draftId: prepared.draft.id, approvalHash: saved.draft.approvalHash,
    version: prepared.draft.version, expectedTarget: { kind: "new" } }))).status, 409, "保存前の版では登録しない");
  // 画面が示した対象と違う期待値では承認しない。
  assert.equal((await intakePost(request("POST", { action: "approve", draftId: prepared.draft.id, approvalHash: saved.draft.approvalHash,
    version: saved.draft.version, expectedTarget: { kind: "replace", revisionId: "rev_" + "0".repeat(32) } }))).status, 409,
    "対象の食い違いは拒否する");

  const approved = await (await intakePost(request("POST", { action: "approve", draftId: prepared.draft.id, approvalHash: saved.draft.approvalHash,
    version: saved.draft.version, expectedTarget: { kind: "new" } }))).json() as any;
  assert.deepEqual(approved.published, { title: "仕事で大切にしていること", publicText: editedText,
    aliases: ["仕事選びの軸", "裁量"], topic: "work_values" }, "実際に登録した内容を返す");
  assert.ok(approved.revisionId, "承認した公開版を登録する");
  assert.equal(approved.replaced, false);
  const repository = new KnowledgeRepository(data.db, jevFixture.ownerId);
  const found = await repository.keyword("仕事選びの軸");
  assert.equal(found.length, 1, "検索語（言い換え）でも同じ公開知識へ到達する");
  assert.ok(found[0].content.includes("裁量"));
  assert.equal(found[0].content.includes("体育会系"), false, "原文の否定表現を持ち込まない");

  // 原文と省略メモは管理用テーブルにだけ残る。
  const sources = await data.db.prepare("SELECT raw_text FROM knowledge_intake_sources").all<{ raw_text: string }>();
  assert.ok(sources.results.some(row => row.raw_text.includes(marker)));
  // 公開側（本文・段落・FTS）へマーカーが流れない。
  const revision = await data.db.prepare("SELECT content FROM knowledge_document_revisions WHERE id=?")
    .bind(approved.revisionId).first<{ content: string }>();
  assert.equal(revision?.content.includes(marker), false);
  const chunks = await data.db.prepare("SELECT content FROM knowledge_chunks WHERE revision_id=?").bind(approved.revisionId).all<{ content: string }>();
  for (const row of chunks.results) assert.equal(row.content.includes(marker), false);
  const fts = await data.db.prepare("SELECT search_text FROM knowledge_fts").all<{ search_text: string }>();
  for (const row of fts.results) assert.equal(row.search_text.includes("83f2a1"), false, "検索語や見出しからも漏らさない");
  const omitted = await data.db.prepare("SELECT omitted_json FROM knowledge_intake_drafts").all<{ omitted_json: string }>();
  assert.ok(omitted.results.some(row => row.omitted_json.includes("順位")), "省略メモは管理用の下書きに残す");
});

test("下書き・保留では公開されず、承認で初めて検索へ入る", async t => {
  const data = await withEnv(t);
  mockModel(t);
  const prepared = await (await intakePost(request("POST", { action: "prepare", title: "仕事の価値観", rawText: rawSource, acknowledgeStorage: true }))).json() as any;
  const held = await (await intakePost(request("POST", { action: "hold", draftId: prepared.draft.id, title: "仕事の価値観",
    publicText: candidate.publicText, aliases: candidate.aliases, topic: "work_values" }))).json() as any;
  assert.equal(held.draft.status, "held");
  const held2 = await data.db.prepare("SELECT COUNT(*) AS count FROM knowledge_document_revisions").first<{ count: number }>();
  assert.equal(Number(held2?.count), 1, "保留では登録しない");
  const approved = await (await intakePost(request("POST", { action: "approve", draftId: prepared.draft.id, approvalHash: held.draft.approvalHash,
    version: held.draft.version, expectedTarget: { kind: "new" } }))).json() as any;
  assert.ok(approved.revisionId);
  const after = await data.db.prepare("SELECT COUNT(*) AS count FROM knowledge_document_revisions").first<{ count: number }>();
  assert.equal(Number(after?.count), 2, "承認で公開版が増える");
});

test("置換は、新しい公開版の承認後にだけ旧版を撤回する", async t => {
  const data = await withEnv(t);
  mockModel(t);
  const active = await data.db.prepare("SELECT active_revision_id FROM knowledge_documents WHERE owner_id=?")
    .bind(jevFixture.ownerId).first<{ active_revision_id: string }>();
  const oldRevision = active?.active_revision_id ?? "";
  assert.ok(oldRevision);
  const prepared = await (await intakePost(request("POST", { action: "prepare", title: "仕事で大切にしていること（公開版）",
    rawText: rawSource, replacesRevisionId: oldRevision, acknowledgeStorage: true }))).json() as any;
  assert.equal(prepared.draft.target.kind, "replace", "保存済み下書きの公開対象を返す（置換）");
  assert.equal(prepared.draft.target.revisionId, oldRevision);
  assert.ok(prepared.draft.target.facts >= 1, "引き継がれないFact数を返す");
  const saved = await (await intakePost(request("POST", { action: "save", draftId: prepared.draft.id, title: "仕事で大切にしていること（公開版）",
    publicText: editedText, aliases: ["仕事選びの軸", "裁量"], topic: "work_values" }))).json() as any;
  const stillApproved = await data.db.prepare("SELECT approval_status FROM knowledge_document_revisions WHERE id=?")
    .bind(oldRevision).first<{ approval_status: string }>();
  assert.equal(stillApproved?.approval_status, "approved", "承認までは旧版を消さない");
  // 置換対象に引き継がれないFactがある場合は、了解なしでは承認しない。
  const refused = await intakePost(request("POST", { action: "approve", draftId: prepared.draft.id,
    approvalHash: saved.draft.approvalHash, version: saved.draft.version,
    expectedTarget: { kind: "replace", revisionId: oldRevision } }));
  assert.equal(refused.status, 409);
  assert.equal(((await refused.json()) as any).error.code, "intake_facts_loss");
  const approved = await (await intakePost(request("POST", { action: "approve", draftId: prepared.draft.id,
    approvalHash: saved.draft.approvalHash, version: saved.draft.version,
    expectedTarget: { kind: "replace", revisionId: oldRevision }, acknowledgeFactLoss: true }))).json() as any;
  assert.equal(approved.replacesRevisionId, oldRevision);
  assert.equal(approved.replaced, true);
  assert.ok(approved.lostFacts >= 1, "引き継がれないFactの件数を返す");
  // 置換は同じ文書の次の版として登録する（別文書を増やさない）。
  const before = await data.db.prepare("SELECT document_id FROM knowledge_document_revisions WHERE id=?").bind(oldRevision).first<{ document_id: string }>();
  const after = await data.db.prepare("SELECT document_id, active_revision_id FROM knowledge_document_revisions r JOIN knowledge_documents d ON d.id=r.document_id WHERE r.id=?")
    .bind(approved.revisionId).first<{ document_id: string; active_revision_id: string }>();
  assert.equal(after?.document_id, before?.document_id, "元の文書の版として登録する");
  assert.equal(after?.active_revision_id, approved.revisionId, "現行版を新しい版へ切り替える");
  const revoked = await data.db.prepare("SELECT approval_status FROM knowledge_document_revisions WHERE id=?")
    .bind(oldRevision).first<{ approval_status: string }>();
  assert.equal(revoked?.approval_status, "revoked", "承認後に旧版を撤回する");
  const repository = new KnowledgeRepository(data.db, jevFixture.ownerId);
  assert.equal((await repository.keyword("ナギサ社")).length, 0, "旧版の本文は検索から消える");
  assert.ok((await repository.keyword("裁量")).length >= 1, "新しい公開版は検索できる");
});

test("取り込みの管理APIは、鍵が無ければ読み書きしない", async t => {
  const data = await withEnv(t);
  mockModel(t);
  const wrong = "b".repeat(48);
  assert.equal((await intakeGet(request("GET", undefined, wrong))).status, 403);
  assert.equal((await intakePost(request("POST", { action: "prepare", title: "x", rawText: rawSource }, wrong))).status, 403);
  const rows = await data.db.prepare("SELECT COUNT(*) AS count FROM knowledge_intake_sources").first<{ count: number }>();
  assert.equal(Number(rows?.count), 0, "拒否した要求は書き込まない");
});

test("公開用候補の形が違えば保存しない", () => {
  assert.throws(() => parseIntakeResult(null), /invalid_intake_result/);
  assert.throws(() => parseIntakeResult({}), /invalid_intake_result/);
  for (const bad of [{ ...candidate, extra: true }, { ...candidate, aliases: [] }, { ...candidate, publicText: "短い" },
    { ...candidate, omitted: [{ item: "x" }] }, { ...candidate, questions: "none" }])
    assert.throws(() => parseIntakeResult(bad), /invalid_intake_result/, JSON.stringify(bad).slice(0, 80));
  // 公開exportは許可したフィールドだけを組み立てる。
  const bundle = intakeBundle({ ownerId: "o", documentId: "pub-1", title: "t", publicText: candidate.publicText, aliases: candidate.aliases });
  assert.deepEqual(Object.keys(bundle).sort(), ["content", "documentId", "entities", "facts", "ownerId", "title", "verification", "version", "visibility"]);
  assert.equal(JSON.stringify(bundle).includes(marker), false);
  assert.equal(JSON.stringify(bundle).includes("体育会系"), false);
});

// 自動リライト（#6）。公開対象として明示した範囲は、意味を保つ言い換えを個別承認なしで採用する。
const autoRequest = (extra: Record<string, unknown> = {}) => request("POST", { action: "auto",
  title: "仕事で大切にしていること", rawText: rawSource, acknowledgeStorage: true, publicTarget: true, ...extra });

test("公開対象として明示した原文は、表現ごとの承認なしで自動リライトして登録する", async t => {
  const data = await withEnv(t);
  mockModel(t);
  // 公開対象としての明示が無ければ、自動採用は実行しない。
  assert.equal((await intakePost(request("POST", { action: "auto", title: "仕事で大切にしていること", rawText: rawSource,
    acknowledgeStorage: true }))).status, 400);
  const before = await data.db.prepare("SELECT COUNT(*) AS count FROM knowledge_document_revisions").first<{ count: number }>();
  assert.equal(Number(before?.count), 1, "明示が無ければ公開しない");

  const auto = await (await intakePost(autoRequest())).json() as any;
  assert.equal(auto.autoAdopted, true, "個別の表現承認なしで採用する");
  assert.equal(auto.held, false);
  assert.ok(auto.revisionId, "公開版を登録する");
  assert.deepEqual(auto.published, { title: "仕事で大切にしていること", publicText: candidate.publicText,
    aliases: candidate.aliases, topic: "work_values" });
  assert.equal(auto.draft.status, "approved");
  assert.equal(auto.draft.autoAdopted, true, "自動採用であることを区別して返す");
  assert.equal(auto.draft.autoPolicyVersion, "intake-auto-interview-rephrase-v1");
  assert.ok(auto.draft.approvedRevisionId);
  // 方針の版・原文の版・公開payloadのhashを、本人レビューとは別に残す。
  const row = await data.db.prepare("SELECT auto_policy_version,auto_adopted,source_hash,approved_hash FROM knowledge_intake_drafts")
    .first<{ auto_policy_version: string; auto_adopted: number; source_hash: string; approved_hash: string }>();
  assert.equal(row?.auto_adopted, 1);
  assert.equal(row?.auto_policy_version, "intake-auto-interview-rephrase-v1");
  assert.ok(row?.source_hash && row?.approved_hash && row.source_hash !== row.approved_hash);
  // 原文は管理用にだけ残り、公開側へマーカーが流れない。
  const sources = await data.db.prepare("SELECT raw_text FROM knowledge_intake_sources").all<{ raw_text: string }>();
  assert.ok(sources.results.some(item => item.raw_text.includes(marker)));
  const revision = await data.db.prepare("SELECT content FROM knowledge_document_revisions WHERE id=?")
    .bind(auto.revisionId).first<{ content: string }>();
  assert.equal(revision?.content.includes(marker), false);
  assert.ok((await new KnowledgeRepository(data.db, jevFixture.ownerId).keyword("裁量")).length >= 1);
});

test("包括許可を超える要確認があるときは、自動採用せず非公開のまま保留する", async t => {
  const data = await withEnv(t);
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (String(url).includes("opencode.ai")) return completion({ ...candidate, questions: ["希望を実績として書いてよいか確認が必要"] });
    throw new Error("unexpected_destination");
  });
  const auto = await (await intakePost(autoRequest())).json() as any;
  assert.equal(auto.autoAdopted, false); assert.equal(auto.held, true); assert.equal(auto.reason, "needs_review");
  assert.equal(auto.draft.status, "held");
  assert.equal(auto.draft.autoAdopted, false);
  const count = await data.db.prepare("SELECT COUNT(*) AS count FROM knowledge_document_revisions").first<{ count: number }>();
  assert.equal(Number(count?.count), 1, "保留では公開しない");
  assert.ok(auto.draft.questions.length >= 1, "要確認を管理用に残す");
});

test("非表示に指定された内容は公開せず、自動採用もしない", async t => {
  const data = await withEnv(t);
  // 架空の規則。実値は応答・ログへ出さず、設定版だけを返す。
  data.env.USER_CONTENT_EXCLUSIONS = JSON.stringify({ version: 1, rules: [{ id: "excluded_topic_001", literal: "架空マーカー語" }] });
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (String(url).includes("opencode.ai")) return completion({ ...candidate,
      publicText: "架空マーカー語を含む公開文です。" + candidate.publicText });
    throw new Error("unexpected_destination");
  });
  const auto = await (await intakePost(autoRequest())).json() as any;
  assert.equal(auto.autoAdopted, false); assert.equal(auto.held, true); assert.equal(auto.reason, "excluded_content");
  assert.ok(auto.exclusionRevision && auto.exclusionRevision !== "none", "設定版だけを返す");
  // 規則の中身（ID・literal）は返さず、版の識別子だけを返す。
  assert.equal(JSON.stringify(auto).includes("excluded_topic_001"), false);
  assert.equal(JSON.stringify(auto).includes("literal"), false);
  const count = await data.db.prepare("SELECT COUNT(*) AS count FROM knowledge_document_revisions").first<{ count: number }>();
  assert.equal(Number(count?.count), 1, "除外では公開しない");
});

test("公開payloadの全項目を、非表示の指定へ照合してから埋め込む", async () => {
  const policy = getContentExclusions({ USER_CONTENT_EXCLUSIONS: JSON.stringify({ version: 1,
    rules: [{ id: "excluded_topic_001", literal: "架空マーカー語" }] }) });
  const base = { version: 1, ownerId: "owner", documentId: "pub-1", title: "見出し", visibility: "public",
    verification: "self_reported", content: "本文だけです。", entities: [], facts: [] };
  const excluded = (error: unknown) => (error as { code?: string }).code === "CONTENT_EXCLUDED";
  await assert.rejects(prepareImport({ ...base, content: "本文に架空マーカー語を含みます。" }, { policy }), excluded);
  await assert.rejects(prepareImport({ ...base, title: "架空マーカー語の見出し" }, { policy }), excluded);
  await assert.rejects(prepareImport({ ...base, entities: ["架空マーカー語"] }, { policy }), excluded);
  await assert.rejects(prepareImport({ ...base, facts: [{ id: "f1", key: "k1", value: "v", statement: "本文だけです。",
    aliases: ["架空マーカー語"], validFrom: null, validTo: null, supersedesFactId: null, lastVerifiedAt: null }] }, { policy }), excluded);
  // 指定が無ければ通る。
  assert.ok(await prepareImport(base));
});

test("意味保持の確認で不合格なら、自動採用せず保留する", async t => {
  const data = await withEnv(t);
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const target = String(url);
    if (target.includes("opencode.ai")) return completion(candidate);
    if (target.includes("api.typesafe.ai")) return Response.json({ answers: judgeReply(JSON.parse(init.body as string).questions,
      { facts_preserved: .1, no_scope_expansion: .1 }) });
    throw new Error("unexpected_destination");
  });
  const auto = await (await intakePost(autoRequest())).json() as any;
  assert.equal(auto.autoAdopted, false); assert.equal(auto.held, true); assert.equal(auto.reason, "meaning_changed");
  assert.equal(auto.draft.status, "held");
  const count = await data.db.prepare("SELECT COUNT(*) AS count FROM knowledge_document_revisions").first<{ count: number }>();
  assert.equal(Number(count?.count), 1, "意味が変わった候補は公開しない");
});

test("意味保持の確認先が使えないときは、自動採用せず保留する", async t => {
  const data = await withEnv(t);
  data.env.TYPESAFE_API_KEY = "";
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (String(url).includes("opencode.ai")) return completion(candidate);
    throw new Error("unexpected_destination");
  });
  const auto = await (await intakePost(autoRequest())).json() as any;
  assert.equal(auto.autoAdopted, false); assert.equal(auto.reason, "meaning_unavailable");
  const count = await data.db.prepare("SELECT COUNT(*) AS count FROM knowledge_document_revisions").first<{ count: number }>();
  assert.equal(Number(count?.count), 1, "判定できないときは公開しない");
});

test("原文に無い数値を足した候補は、自動採用しない", async t => {
  const data = await withEnv(t);
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (String(url).includes("opencode.ai")) return completion({ ...candidate,
      publicText: "年間利益は500万円です。" + candidate.publicText });
    throw new Error("unexpected_destination");
  });
  const auto = await (await intakePost(autoRequest())).json() as any;
  assert.equal(auto.autoAdopted, false); assert.equal(auto.reason, "numbers_introduced");
  const count = await data.db.prepare("SELECT COUNT(*) AS count FROM knowledge_document_revisions").first<{ count: number }>();
  assert.equal(Number(count?.count), 1);
});

test("同じrequestIdの再送では、保存済みの下書きを使い回して重複しない", async t => {
  const data = await withEnv(t);
  mockModel(t);
  const requestId = "11111111-2222-4333-8444-555555555555";
  const first = await (await intakePost(autoRequest({ requestId }))).json() as any;
  assert.equal(first.autoAdopted, true);
  const second = await (await intakePost(autoRequest({ requestId }))).json() as any;
  assert.equal(second.reused, true, "再送は生成も公開もやり直さない");
  assert.equal(second.draft.id, first.draft.id);
  const sources = await data.db.prepare("SELECT COUNT(*) AS count FROM knowledge_intake_sources").first<{ count: number }>();
  assert.equal(Number(sources?.count), 1, "原文を重複して作らない");
  const revisions = await data.db.prepare("SELECT COUNT(*) AS count FROM knowledge_document_revisions").first<{ count: number }>();
  assert.equal(Number(revisions?.count), 2, "公開版も重複しない");
});

test("自動採用した公開版は、後から取り消せる", async t => {
  const data = await withEnv(t);
  mockModel(t);
  const auto = await (await intakePost(autoRequest())).json() as any;
  assert.equal(auto.autoAdopted, true);
  const cancelled = await (await intakePost(request("POST", { action: "cancel", draftId: auto.draft.id }))).json() as any;
  assert.equal(cancelled.revoked, true);
  assert.equal(cancelled.revisionId, auto.revisionId);
  assert.equal(cancelled.draft.status, "rejected");
  const status = await data.db.prepare("SELECT approval_status FROM knowledge_document_revisions WHERE id=?")
    .bind(auto.revisionId).first<{ approval_status: string }>();
  assert.equal(status?.approval_status, "revoked");
  // 取り消し後は、検索へ戻らない（置換前の旧版も自動で復活させない）。
  assert.equal((await new KnowledgeRepository(data.db, jevFixture.ownerId).keyword("裁量")).length, 0);
});

test("登録済みの下書きを編集して再承認すると、同じ文書の新しい版になる", async t => {
  const data = await withEnv(t);
  mockModel(t);
  const auto = await (await intakePost(autoRequest())).json() as any;
  const saved = await (await intakePost(request("POST", { action: "save", draftId: auto.draft.id,
    title: "仕事で大切にしていること", publicText: editedText, aliases: ["仕事選びの軸", "裁量"], topic: "work_values" }))).json() as any;
  assert.equal(saved.draft.status, "draft", "登録済みでも編集して保存できる");
  const approved = await (await intakePost(request("POST", { action: "approve", draftId: auto.draft.id,
    approvalHash: saved.draft.approvalHash, version: saved.draft.version,
    expectedTarget: { kind: "replace", revisionId: auto.revisionId } }))).json() as any;
  assert.ok(approved.revisionId); assert.notEqual(approved.revisionId, auto.revisionId);
  const old = await data.db.prepare("SELECT approval_status FROM knowledge_document_revisions WHERE id=?")
    .bind(auto.revisionId).first<{ approval_status: string }>();
  assert.equal(old?.approval_status, "revoked", "公開中の版を直接書き換えず、古い版は失効する");
});

test("置換で承認したカードは、編集して再承認しても対象を見失わない", async t => {
  const data = await withEnv(t);
  mockModel(t);
  const active = await data.db.prepare("SELECT active_revision_id FROM knowledge_documents WHERE owner_id=?")
    .bind(jevFixture.ownerId).first<{ active_revision_id: string }>();
  const oldRevision = active?.active_revision_id ?? "";
  const prepared = await (await intakePost(request("POST", { action: "prepare", title: "仕事で大切にしていること（公開版）",
    rawText: rawSource, replacesRevisionId: oldRevision, acknowledgeStorage: true }))).json() as any;
  const saved = await (await intakePost(request("POST", { action: "save", draftId: prepared.draft.id,
    title: "仕事で大切にしていること（公開版）", publicText: editedText, aliases: ["仕事選びの軸", "裁量"], topic: "work_values" }))).json() as any;
  const approved = await (await intakePost(request("POST", { action: "approve", draftId: prepared.draft.id,
    approvalHash: saved.draft.approvalHash, version: saved.draft.version,
    expectedTarget: { kind: "replace", revisionId: oldRevision }, acknowledgeFactLoss: true }))).json() as any;
  assert.ok(approved.revisionId);
  // 承認後は、元の置換先が撤回済みでも、現行版から対象を解決する（unresolvedにしない）。
  const reopened = await (await intakePost(request("POST", { action: "save", draftId: prepared.draft.id,
    title: "仕事で大切にしていること（公開版）", publicText: editedText + "補足します。",
    aliases: ["仕事選びの軸", "裁量"], topic: "work_values" }))).json() as any;
  assert.equal(reopened.draft.target.kind, "replace", "元の置換先が古くても、現行版から解決する");
  assert.equal(reopened.draft.target.revisionId, approved.revisionId);
  const again = await (await intakePost(request("POST", { action: "approve", draftId: prepared.draft.id,
    approvalHash: reopened.draft.approvalHash, version: reopened.draft.version,
    expectedTarget: { kind: "replace", revisionId: approved.revisionId } }))).json() as any;
  assert.ok(again.revisionId); assert.notEqual(again.revisionId, approved.revisionId);
});

test("非表示の指定に当たる原文・文書名は、外部の変換へ送らない", async t => {
  const data = await withEnv(t);
  data.env.USER_CONTENT_EXCLUSIONS = JSON.stringify({ version: 1, rules: [{ id: "excluded_topic_001", literal: "架空マーカー語" }] });
  let modelCalls = 0;
  t.mock.method(globalThis, "fetch", async () => { modelCalls++; throw new Error("must_not_call"); });
  // 文書名が指定に当たる場合は、外部呼出の前に拒否する。
  assert.equal((await intakePost(request("POST", { action: "prepare", title: "架空マーカー語の記録",
    rawText: rawSource, acknowledgeStorage: true }))).status, 422);
  // 除外後に公開できる本文が残らない場合も、外部呼出の前に拒否する。
  assert.equal((await intakePost(request("POST", { action: "prepare", title: "仕事の価値観",
    rawText: "架空マーカー語について、ここに長めの内省メモを書いています。", acknowledgeStorage: true }))).status, 422);
  // 自動取り込みでも、文書名が指定に当たる場合は外部呼出をせず保留する。
  const autoTitle = await (await intakePost(autoRequest({ title: "架空マーカー語の記録" }))).json() as any;
  assert.equal(autoTitle.autoAdopted, false); assert.equal(autoTitle.reason, "excluded_title");
  assert.equal(modelCalls, 0, "非表示の内容を外部の変換へ送らない");
});

test("自動採用のあとに手動で再承認したら、自動の印を残さない", async t => {
  const data = await withEnv(t);
  mockModel(t);
  const auto = await (await intakePost(autoRequest())).json() as any;
  assert.equal(auto.draft.autoAdopted, true);
  const saved = await (await intakePost(request("POST", { action: "save", draftId: auto.draft.id,
    title: "仕事で大切にしていること", publicText: editedText, aliases: ["仕事選びの軸", "裁量"], topic: "work_values" }))).json() as any;
  const approved = await (await intakePost(request("POST", { action: "approve", draftId: auto.draft.id,
    approvalHash: saved.draft.approvalHash, version: saved.draft.version,
    expectedTarget: { kind: "replace", revisionId: auto.revisionId } }))).json() as any;
  assert.equal(approved.draft.autoAdopted, false, "手動の再承認は自動採用と区別する");
  assert.equal(approved.draft.autoPolicyVersion, "");
});

test("反映待ちで止まった自動取り込みは、同じrequestIdの再送で末尾から再開する", async t => {
  const data = await withEnv(t);
  let modelCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const target = String(url);
    if (target.includes("opencode.ai")) { modelCalls++; return completion(candidate); }
    if (target.includes("api.typesafe.ai")) return Response.json({ answers: judgeReply(JSON.parse(init.body as string).questions) });
    throw new Error("unexpected_destination");
  });
  const requestId = "22222222-3333-4444-8555-666666666666";
  // 索引づくりが失敗し、候補は保存済みのまま未完了になる。
  data.vector.failed = true;
  assert.equal((await intakePost(autoRequest({ requestId }))).status, 503);
  assert.equal(modelCalls, 1);
  const incomplete = await data.db.prepare("SELECT status,public_text FROM knowledge_intake_drafts WHERE id=?")
    .bind(requestId).first<{ status: string; public_text: string }>();
  assert.equal(incomplete?.status, "draft");
  assert.ok((incomplete?.public_text ?? "").length > 0, "生成した候補は保存されている");
  // 同じrequestIdで再送すると、LLMで作り直さず、点検・公開の末尾から再開する。
  data.vector.failed = false;
  const retried = await (await intakePost(autoRequest({ requestId }))).json() as any;
  assert.equal(retried.autoAdopted, true);
  assert.equal(modelCalls, 1, "LLMでは作り直さない");
  assert.ok(retried.revisionId);
});

test("同じrequestIdでも内容が違えば、黙って使い回さない", async t => {
  const data = await withEnv(t);
  mockModel(t);
  const requestId = "33333333-4444-4555-8666-777777777777";
  assert.equal((await (await intakePost(autoRequest({ requestId }))).json() as any).autoAdopted, true);
  const conflict = await intakePost(autoRequest({ requestId, title: "別の見出し" }));
  assert.equal(conflict.status, 409);
  assert.equal(((await conflict.json()) as any).error.code, "intake_request_conflict");
});

test("生成が終わっていない確保は、その場で作り直さず保留を知らせる", async t => {
  const data = await withEnv(t);
  let modelCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (String(url).includes("opencode.ai")) { modelCalls++; throw new Error("generation_down"); }
    throw new Error("unexpected_destination");
  });
  const requestId = "44444444-5555-4666-8777-888888888888";
  assert.equal((await intakePost(autoRequest({ requestId }))).status, 503);
  assert.equal(modelCalls, 1);
  const pending = await (await intakePost(autoRequest({ requestId }))).json() as any;
  assert.equal(pending.pending, true); assert.equal(pending.reason, "generation_incomplete");
  assert.equal(modelCalls, 1, "同時の二重生成を避ける");
});

test("置換の後片付けが終わらなくても、公開は完了し保留中を返す", async t => {
  const data = await withEnv(t);
  mockModel(t);
  const active = await data.db.prepare("SELECT active_revision_id FROM knowledge_documents WHERE owner_id=?")
    .bind(jevFixture.ownerId).first<{ active_revision_id: string }>();
  const prepared = await (await intakePost(request("POST", { action: "prepare", title: "仕事で大切にしていること（公開版）",
    rawText: rawSource, replacesRevisionId: active?.active_revision_id, acknowledgeStorage: true }))).json() as any;
  const saved = await (await intakePost(request("POST", { action: "save", draftId: prepared.draft.id,
    title: "仕事で大切にしていること（公開版）", publicText: editedText, aliases: ["仕事選びの軸", "裁量"], topic: "work_values" }))).json() as any;
  // 旧版の索引削除だけが失敗する（D1の遮断は先に終わっている）。
  data.vector.deleteByIds = async () => { throw new Error("simulated_delete_failure"); };
  const approved = await (await intakePost(request("POST", { action: "approve", draftId: prepared.draft.id,
    approvalHash: saved.draft.approvalHash, version: saved.draft.version,
    expectedTarget: { kind: "replace", revisionId: active?.active_revision_id }, acknowledgeFactLoss: true }))).json() as any;
  assert.ok(approved.revisionId, "公開は完了する");
  assert.equal(approved.replaced, true);
  assert.equal(approved.vectorCleanupPending, true, "後片付けの保留を返す");
});

test("保留・手動保存のあとの古い再送は、公開しない", async t => {
  const data = await withEnv(t);
  // 1回目は要確認で保留になる（自動では公開しない）。
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const target = String(url);
    if (target.includes("opencode.ai")) return completion({ ...candidate, questions: ["確認が必要"] });
    if (target.includes("api.typesafe.ai")) return Response.json({ answers: judgeReply(JSON.parse(init.body as string).questions) });
    throw new Error("unexpected_destination");
  });
  const requestId = "55555555-6666-4777-8888-999999999999";
  const held = await (await intakePost(autoRequest({ requestId }))).json() as any;
  assert.equal(held.held, true); assert.equal(held.draft.status, "held");
  // 保留の終端は、古い再送では公開しない。
  const resent = await (await intakePost(autoRequest({ requestId }))).json() as any;
  assert.equal(resent.autoAdopted, false); assert.equal(resent.reason, "held_terminal");
  // 本人が手動で保存したあとも、古い再送では公開しない。
  await intakePost(request("POST", { action: "save", draftId: requestId, title: "仕事で大切にしていること",
    publicText: editedText, aliases: ["仕事選びの軸", "裁量"], topic: "work_values" }));
  const afterSave = await (await intakePost(autoRequest({ requestId }))).json() as any;
  assert.equal(afterSave.autoAdopted, false); assert.equal(afterSave.reason, "manual_review");
  const count = await data.db.prepare("SELECT COUNT(*) AS count FROM knowledge_document_revisions").first<{ count: number }>();
  assert.equal(Number(count?.count), 1, "古い再送では公開しない");
});

test("期限切れの確保は、versionの比較で1つだけが引き継げる", async () => {
  const data = await setup();
  try {
    await createIntakeSource(data.db, { id: "src1", owner_id: jevFixture.ownerId, title: "t", raw_text: "本文です。",
      content_hash: "h", replaces_revision_id: null, created_at: "2026-09-21T00:00:00Z" });
    await createIntakeDraft(data.db, { id: "d1", owner_id: jevFixture.ownerId, source_id: "src1", status: "draft", title: "t",
      public_text: "", aliases_json: "[]", topic: "", kept_json: "[]", omitted_json: "[]", questions_json: "[]", model: "",
      prompt_version: "", source_hash: "h", approved_revision_id: null, approved_hash: null,
      auto_policy_version: "intake-auto-interview-rephrase-v1", auto_adopted: 0,
      created_at: "2026-09-21T00:00:00Z", updated_at: "2026-09-21T00:00:00Z", version: 1 });
    const first = await claimExpiredIntakeDraft(data.db, jevFixture.ownerId, "d1", 1, "token-a", "2026-09-21T00:05:00Z");
    const second = await claimExpiredIntakeDraft(data.db, jevFixture.ownerId, "d1", 1, "token-b", "2026-09-21T00:05:00Z");
    assert.equal(first, true, "先に読んだ版で引き継げる");
    assert.equal(second, false, "同じ版での二重取得を防ぐ");
  } finally { data.db.close(); }
});

test("生成中に却下したら、遅れて戻った生成で公開しない", async t => {
  const data = await withEnv(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const target = String(url);
    if (target.includes("opencode.ai")) { await gate; return completion(candidate); }
    if (target.includes("api.typesafe.ai")) return Response.json({ answers: judgeReply(JSON.parse(init.body as string).questions) });
    throw new Error("unexpected_destination");
  });
  const requestId = "66666666-7777-4888-8999-000000000000";
  // 生成を止めたまま開始し、確保された下書きが見えたら本人が却下する。
  const started = intakePost(autoRequest({ requestId }));
  for (let attempt = 0; attempt < 40; attempt++) {
    const row = await data.db.prepare("SELECT id FROM knowledge_intake_drafts WHERE id=?").bind(requestId).first<{ id: string }>();
    if (row) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await intakePost(request("POST", { action: "reject", draftId: requestId }));
  release();
  const result = await (await started).json() as any;
  assert.equal(result.autoAdopted, false, "遅れて戻った生成で公開しない");
  assert.equal(result.reason, "manual_review");
  // 却下は保持される。
  const row = await data.db.prepare("SELECT status FROM knowledge_intake_drafts WHERE id=?").bind(requestId).first<{ status: string }>();
  assert.equal(row?.status, "rejected");
  const count = await data.db.prepare("SELECT COUNT(*) AS count FROM knowledge_document_revisions").first<{ count: number }>();
  assert.equal(Number(count?.count), 1, "公開版を増やさない");
});

test("同じ版の候補CASは、書き換えた1つだけが成功する", async () => {
  const data = await setup();
  try {
    await createIntakeSource(data.db, { id: "src2", owner_id: jevFixture.ownerId, title: "t", raw_text: "本文です。",
      content_hash: "h", replaces_revision_id: null, created_at: "2026-09-21T00:00:00Z" });
    await createIntakeDraft(data.db, { id: "d2", owner_id: jevFixture.ownerId, source_id: "src2", status: "draft", title: "t",
      public_text: "", aliases_json: "[]", topic: "", kept_json: "[]", omitted_json: "[]", questions_json: "[]", model: "",
      prompt_version: "", source_hash: "h", approved_revision_id: null, approved_hash: null,
      auto_policy_version: "t1", auto_adopted: 0, created_at: "2026-09-21T00:00:00Z", updated_at: "2026-09-21T00:00:00Z", version: 1 });
    const change = { title: "t", publicText: "候補の本文です。", aliases: ["a"], topic: "x", kept: [], omitted: [],
      questions: [], status: "draft" as const, updatedAt: "2026-09-21T00:01:00Z" };
    const first = await updateIntakeCandidate(data.db, jevFixture.ownerId, "d2", { version: 1, token: "t1" }, change);
    const second = await updateIntakeCandidate(data.db, jevFixture.ownerId, "d2", { version: 1, token: "t1" }, change);
    assert.equal(first, true, "書き換えた要求だけが成功する");
    assert.equal(second, false, "同じ版の二重書き込みを成功にしない");
  } finally { data.db.close(); }
});

test("公開の切り替え時点で却下されていたら、公開しない", async () => {
  const data = await setup();
  try {
    await createIntakeSource(data.db, { id: "src3", owner_id: jevFixture.ownerId, title: "t", raw_text: "本文です。",
      content_hash: "h", replaces_revision_id: null, created_at: "2026-09-21T00:00:00Z" });
    await createIntakeDraft(data.db, { id: "d3", owner_id: jevFixture.ownerId, source_id: "src3", status: "rejected", title: "t",
      public_text: "本文です。", aliases_json: "[]", topic: "", kept_json: "[]", omitted_json: "[]", questions_json: "[]", model: "",
      prompt_version: "", source_hash: "h", approved_revision_id: null, approved_hash: null,
      auto_policy_version: "t1", auto_adopted: 0, created_at: "2026-09-21T00:00:00Z", updated_at: "2026-09-21T00:00:00Z", version: 2 });
    const prepared = await prepareImport({ version: 1, ownerId: jevFixture.ownerId, documentId: "pub-cas",
      title: "見出し", visibility: "public", verification: "self_reported", content: "本文です。", entities: [], facts: [] });
    await assert.rejects(approveImport({ db: data.db, vector: data.vector, embedding, prepared,
      approvalHash: prepared.hash, signal: new AbortController().signal,
      attempt: { draftId: "d3", version: 2, token: "t1", approval: { revisionId: prepared.revisionId, hash: prepared.hash,
        policyVersion: "intake-auto-interview-rephrase-v1", updatedAt: "2026-09-21T00:02:00Z" } } }), /intake_attempt_stale/);
    // 公開へ切り替わらず、却下も保持する。
    const revision = await data.db.prepare("SELECT approval_status FROM knowledge_document_revisions WHERE id=?")
      .bind(prepared.revisionId).first<{ approval_status: string }>();
    assert.notEqual(revision?.approval_status, "approved");
    const draft = await data.db.prepare("SELECT status,auto_adopted FROM knowledge_intake_drafts WHERE id=?")
      .bind("d3").first<{ status: string; auto_adopted: number }>();
    assert.equal(draft?.status, "rejected"); assert.equal(draft?.auto_adopted, 0);
  } finally { data.db.close(); }
});
