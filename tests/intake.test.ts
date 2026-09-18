import test from "node:test";
import assert from "node:assert/strict";
import { GET as intakeGet, POST as intakePost } from "../app/api/admin/intake/route.ts";
import { intakeBundle, parseIntakeResult } from "../lib/knowledge/intake.ts";
import { KnowledgeRepository } from "../lib/knowledge/repository.ts";
import { jevBindings, jevFixture } from "./fixtures/jev.ts";

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
    throw new Error("unexpected_destination");
  });
  return embedded;
}

test("原文から公開用候補を作り、本人が編集した公開文だけを検索へ登録する", async t => {
  const data = await withEnv(t);
  mockModel(t);
  const prepared = await (await intakePost(request("POST", { action: "prepare", title: "仕事で大切にしていること", rawText: rawSource }))).json() as any;
  assert.equal(prepared.draft.publicText, candidate.publicText, "候補の本文を返す");
  assert.equal(prepared.draft.omitted.length, candidate.omitted.length, "省略した内容と理由は管理用に残す");
  assert.ok(prepared.draft.omitted[0].item.includes("順位の詳細"));
  assert.equal(prepared.draft.omitted[0].reason, candidate.omitted[0].reason);
  assert.ok(prepared.draft.approvalHash, "承認に使うhashを返す");
  const before = await data.db.prepare("SELECT COUNT(*) AS count FROM knowledge_document_revisions").first<{ count: number }>();
  assert.equal(Number(before?.count), 1, "候補づくりでは公開しない");

  const saved = await (await intakePost(request("POST", { action: "save", draftId: prepared.draft.id, title: "仕事で大切にしていること",
    publicText: editedText, aliases: ["仕事選びの軸", "裁量"], topic: "work_values" }))).json() as any;
  assert.notEqual(saved.draft.approvalHash, prepared.draft.approvalHash, "編集で承認hashが変わる");
  assert.equal((await intakePost(request("POST", { action: "approve", draftId: prepared.draft.id, approvalHash: prepared.draft.approvalHash }))).status, 409,
    "編集前の古いhashでは登録しない");

  const approved = await (await intakePost(request("POST", { action: "approve", draftId: prepared.draft.id, approvalHash: saved.draft.approvalHash }))).json() as any;
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
  const prepared = await (await intakePost(request("POST", { action: "prepare", title: "仕事の価値観", rawText: rawSource }))).json() as any;
  const held = await (await intakePost(request("POST", { action: "hold", draftId: prepared.draft.id, title: "仕事の価値観",
    publicText: candidate.publicText, aliases: candidate.aliases, topic: "work_values" }))).json() as any;
  assert.equal(held.draft.status, "held");
  const held2 = await data.db.prepare("SELECT COUNT(*) AS count FROM knowledge_document_revisions").first<{ count: number }>();
  assert.equal(Number(held2?.count), 1, "保留では登録しない");
  const approved = await (await intakePost(request("POST", { action: "approve", draftId: prepared.draft.id, approvalHash: held.draft.approvalHash }))).json() as any;
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
    rawText: rawSource, replacesRevisionId: oldRevision }))).json() as any;
  const saved = await (await intakePost(request("POST", { action: "save", draftId: prepared.draft.id, title: "仕事で大切にしていること（公開版）",
    publicText: editedText, aliases: ["仕事選びの軸", "裁量"], topic: "work_values" }))).json() as any;
  const stillApproved = await data.db.prepare("SELECT approval_status FROM knowledge_document_revisions WHERE id=?")
    .bind(oldRevision).first<{ approval_status: string }>();
  assert.equal(stillApproved?.approval_status, "approved", "承認までは旧版を消さない");
  const approved = await (await intakePost(request("POST", { action: "approve", draftId: prepared.draft.id, approvalHash: saved.draft.approvalHash }))).json() as any;
  assert.equal(approved.replacesRevisionId, oldRevision);
  assert.equal(approved.replaced, true);
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
