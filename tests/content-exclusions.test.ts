// 非表示対象のポリシーを、架空の値だけで確認する。
// 実値はサーバーSecret（USER_CONTENT_EXCLUSIONS）にだけ置き、このテストへ持ち込まない。
import test from "node:test";
import assert from "node:assert/strict";
import { assertAllowedContent, containsExcludedContent, emptyContentExclusions, excludedContentMask,
  excludedContentReply, getContentExclusions } from "../lib/security/content-exclusions.ts";
import { PublicError } from "../lib/security/request.ts";

// 架空の非表示語。英字（大小・全角・字間空白）、短い英字、短い日本語、長い日本語を1つずつ。
const fictional = { version: 1, rules: [
  { id: "secret_lab", literal: "Secret Lab" },
  { id: "lab", literal: "Lab" },
  { id: "short_en", literal: "ai" },
  { id: "short_jp", literal: "あい" },
  { id: "hidden_jp", literal: "ひみつラボ" }
] };
const configured = (value: unknown = fictional) => getContentExclusions({ USER_CONTENT_EXCLUSIONS: JSON.stringify(value) });

test("非表示設定の欠落は拒否し、規則なしは明示した場合だけ許可する", () => {
  for (const env of [{}, { USER_CONTENT_EXCLUSIONS: "" }]) {
    assert.throws(() => getContentExclusions(env), (error: unknown) => {
      assert.ok(error instanceof PublicError);
      assert.equal(error.code, "EXCLUSION_NOT_CONFIGURED");
      assert.equal(error.status, 503);
      return true;
    });
  }
  const empty = configured({ version: 1, rules: [] });
  assert.equal(empty.matches("Secret Lab の話"), false);
  assert.deepEqual(empty.matchedRuleIds("Secret Lab"), []);
  assert.equal(empty.mask("そのまま返す文"), "そのまま返す文");
  assert.equal(emptyContentExclusions.matches("なんでも"), false);
});

test("英字は大小・全角・字間の空白を同じ規則で見て、無関係な語を変えない", () => {
  const policy = configured();
  for (const text of ["secret lab の研究", "Ｓｅｃｒｅｔ　Ｌａｂ の研究", "s e c r e t l a b の研究",
    "Se\u200Bcret Lab の研究"]) assert.equal(policy.matches(text), true, text);
  assert.deepEqual(policy.matchedRuleIds("SECRET LAB"), ["secret_lab", "lab"]);
  for (const text of ["secret laboratory の話", "collaborate の話", "train の話", "秘密の話"]) {
    assert.equal(policy.matches(text), false, text);
  }
});

test("短い語は単語の途中で拾わない", () => {
  const policy = configured();
  for (const text of ["あいさつを大切にしています", "あいさつ", "はい、あいさつです"]) assert.equal(policy.matches(text), false, text);
  assert.equal(policy.matches("あい の話"), true);
  assert.equal(policy.matches("あい"), true);
  for (const text of ["train", "said", "AI の話と train"]) assert.equal(policy.matches(text), text === "AI の話と train");
});

test("長い語は語中の指定として一致する", () => {
  const policy = configured();
  assert.equal(policy.matches("ひみつラボの話"), true);
  assert.equal(policy.matches("大ひみつラボ"), true);
  assert.deepEqual(policy.matchedRuleIds("ひみつラボ"), ["hidden_jp"]);
});

test("該当した発話は丸ごと非表示にし、無関係な文はそのまま返す", () => {
  const policy = configured();
  assert.equal(policy.mask("ひみつラボの話を教えて"), excludedContentMask);
  assert.equal(policy.mask("Secret Lab での担当は？"), excludedContentMask);
  assert.equal(policy.mask("仕事の進め方を教えて"), "仕事の進め方を教えて");
  assert.equal(excludedContentMask, "［非表示の内容］");
  assert.match(excludedContentReply, /お答えしていません/);
});

test("設定版は内容ごとに変わり、規則そのものを外へ出さない", () => {
  const policy = configured();
  assert.equal(policy.revision, configured().revision, "同じ設定なら同じ識別");
  assert.notEqual(configured({ version: 2, rules: fictional.rules }).revision, policy.revision, "版が変われば識別も変わる");
  assert.doesNotMatch(policy.revision, /secret|lab|ひみつ|あい/i);
  assert.deepEqual(Object.keys(policy).sort(), ["mask", "matchedRuleIds", "matches", "revision"], "規則の一覧を公開しない");
});

test("文字列・DBのJSON列・配列・入れ子を同じ規則で確認する", () => {
  const policy = configured();
  assert.equal(containsExcludedContent("ひみつラボ", policy), true);
  assert.equal(containsExcludedContent("[\"Secret Lab\"]", policy), true, "JSON列のaliasも見る");
  assert.equal(containsExcludedContent({ aliases: ["無関係な語", "ひみつラボ"] }, policy), true);
  assert.equal(containsExcludedContent([{ nested: "secret lab" }], policy), true);
  assert.equal(containsExcludedContent("仕事の進め方", policy), false);
  assert.equal(containsExcludedContent({ aliases: ["要件整理"] }, policy), false);
  assert.equal(containsExcludedContent(42, policy), false);
  assert.equal(containsExcludedContent(null, policy), false);
});

test("含むときだけ公開前の確認で拒否する", () => {
  const policy = configured();
  assert.doesNotThrow(() => assertAllowedContent({ title: "仕事の進め方", aliases: ["要件整理"] }, policy));
  assert.throws(() => assertAllowedContent({ title: "ひみつラボ", aliases: [] }, policy), (error: unknown) => {
    assert.ok(error instanceof PublicError);
    assert.equal(error.code, "CONTENT_EXCLUDED");
    assert.equal(error.status, 422);
    assert.doesNotMatch(error.message, /ひみつラボ|Secret Lab/);
    return true;
  });
});

test("壊れた設定は公開前の確認で止め、値をメッセージへ出さない", () => {
  const long = "あ".repeat(201);
  const broken = ["{", "[]", JSON.stringify({ rules: [] }), JSON.stringify({ version: 0, rules: [] }),
    JSON.stringify({ version: 1, rules: {} }),
    JSON.stringify({ version: 1, rules: Array.from({ length: 65 }, (_, index) => ({ id: `r${index}`, literal: "x" })) }),
    JSON.stringify({ version: 1, rules: [{ id: "dup", literal: "a" }, { id: "dup", literal: "b" }] }),
    JSON.stringify({ version: 1, rules: [{ id: "大文字", literal: "a" }] }),
    JSON.stringify({ version: 1, rules: [{ id: "empty", literal: "   " }] }),
    JSON.stringify({ version: 1, rules: [{ id: "blank", literal: "\u200B" }] }),
    JSON.stringify({ version: 1, rules: [{ id: "long", literal: long }] }),
    JSON.stringify({ version: 1, rules: [{ id: "ok", literal: "secret lab" }] }).padEnd(32_001, " ")];
  for (const raw of broken) {
    assert.throws(() => getContentExclusions({ USER_CONTENT_EXCLUSIONS: raw }), (error: unknown) => {
      assert.ok(error instanceof PublicError, raw.slice(0, 24));
      assert.equal(error.code, "EXCLUSION_NOT_CONFIGURED");
      assert.equal(error.status, 503);
      assert.doesNotMatch(error.message, /secret lab|ひみつ/i);
      return true;
    });
  }
});
