// 公開用語辞書の回帰。架空の名称・別名だけで確認する（実値は持ち込まない）。
// 辞書は親の publicTerms() が返す現行の公開分だけを前提にし、ここでは置換・候補・版の規則を見る。
import test from "node:test";
import assert from "node:assert/strict";
import { applyExplicitTerms, correctionCandidates, dictionaryRevision, emptyTermDictionary,
  maxCorrectionCandidates, type TermDictionary } from "../lib/voice/input/terms.ts";
import type { PublicTerm } from "../lib/knowledge/repository.ts";

const term = (termId: string, canonical: string, aliases: string[], sourceRevision = "rev_a"): PublicTerm =>
  ({ termId, canonical, aliases, sourceRevision });
const dictionary = (...terms: PublicTerm[]): TermDictionary => ({ revision: "test-1", terms });
const sakura = term("sakura", "Sakura Lab", ["さくらラボ", "sakura lab"]);

test("明示された一意の別名だけを名称へ置き換え、変更箇所を残す", () => {
  const result = applyExplicitTerms("さくらラボの仕事を教えて", dictionary(sakura));
  assert.equal(result.text, "Sakura Labの仕事を教えて");
  assert.deepEqual(result.edits, [{ rule: "dictionary", before: "さくらラボ", after: "Sakura Lab" }]);
  assert.equal(applyExplicitTerms("関係ない話です", dictionary(sakura)).text, "関係ない話です");
});

test("字間に入った空白を許して一致する", () => {
  assert.equal(applyExplicitTerms("さ く ら ラ ボの仕事", dictionary(sakura)).text, "Sakura Labの仕事");
  // 英字は、空白を除くと名称そのものが入っている文として扱う（別名へ戻さない）。
  for (const text of ["s a k u r a l a b の仕事", "sakura lab の仕事"]) {
    assert.equal(applyExplicitTerms(text, dictionary(sakura)).text, text, text);
  }
});

test("漢字を含む一般語と短い別名は、自動では置き換えない", () => {
  const kanji = term("office", "Tokyo Office", ["東京"], "rev_c");
  const shortKana = term("ai", "AI", ["えー"], "rev_c");
  const result = applyExplicitTerms("東京のえー の話", dictionary(kanji, shortKana));
  assert.equal(result.text, "東京のえー の話");
  assert.deepEqual(result.edits, []);
});

test("同じ別名が複数の名称へ対応するときは、勝手に決めない", () => {
  const first = term("lab_a", "Sakura Lab", ["さくらラボ"], "rev_a");
  const second = term("lab_b", "Hikari Lab", ["さくらラボ"], "rev_b");
  const result = applyExplicitTerms("さくらラボの仕事", dictionary(first, second));
  assert.equal(result.text, "さくらラボの仕事");
  assert.deepEqual(result.edits, []);
});

test("英字の別名は単語の境界を守る", () => {
  // 名称と字面が違う別名は、境界を確認して置き換える。
  const shortForm = term("sakura", "Sakura Lab", ["sakura"], "rev_a");
  assert.equal(applyExplicitTerms("sakura の仕事", dictionary(shortForm)).text, "Sakura Lab の仕事");
  for (const text of ["xsakura の仕事", "sakuras の仕事"]) {
    assert.equal(applyExplicitTerms(text, dictionary(shortForm)).text, text, text);
  }
});

test("名称がすでに入っている文は、別名へ戻さない", () => {
  const text = "Sakura Lab の さくらラボ";
  assert.equal(applyExplicitTerms(text, dictionary(sakura)).text, text);
});

test("別名は長いものから当てる", () => {
  const withShort = term("sakura", "Sakura Lab", ["さくら", "さくらラボ"], "rev_a");
  const result = applyExplicitTerms("さくらラボの仕事", dictionary(withShort));
  assert.equal(result.text, "Sakura Labの仕事");
  assert.equal(result.edits.length, 1, "短い別名で二重置換しない");
});

test("補正案は返った候補だけから作り、最大3件で重複を除く", () => {
  assert.equal(maxCorrectionCandidates, 3);
  const candidates = correctionCandidates({ base: "さくらラボの話",
    alternatives: ["さくらラボのはなし", "さくらラボの話", "サクララボの話", "さらに別の話"],
    dictionary: dictionary(sakura) });
  assert.equal(candidates.length, maxCorrectionCandidates);
  assert.equal(candidates.some(candidate => candidate.text === "さくらラボの話"), false, "元と同じ候補は入れない");
  assert.deepEqual(candidates.map(candidate => candidate.id), ["stt_1", "stt_3", "stt_4"]);
  assert.ok(candidates.every(candidate => candidate.sources.includes("stt")));
});

test("対応が一意でない別名は、両方の名称を候補として残す", () => {
  const first = term("lab_a", "Sakura Lab", ["さくらラボ"], "rev_a");
  const second = term("lab_b", "Hikari Lab", ["さくらラボ"], "rev_b");
  const candidates = correctionCandidates({ base: "さくらラボの仕事", dictionary: dictionary(first, second) });
  assert.deepEqual(candidates.map(candidate => candidate.text).sort(), ["Hikari Labの仕事", "Sakura Labの仕事"]);
  assert.ok(candidates.every(candidate => candidate.sources.includes("dictionary")));
});

test("辞書の版は、資料版と除外設定版が変われば作り直す", () => {
  const base = dictionaryRevision([sakura], "policy-1");
  assert.equal(dictionaryRevision([sakura], "policy-1"), base, "同じ条件なら同じ版");
  assert.notEqual(dictionaryRevision([sakura], "policy-2"), base, "除外設定版が変われば変わる");
  assert.notEqual(dictionaryRevision([sakura, term("hikari", "Hikari Works", ["ひかりワークス"], "rev_b")], "policy-1"),
    base, "資料版が増えれば変わる");
  assert.notEqual(dictionaryRevision([term("sakura", "Sakura Lab", ["さくらラボ"], "rev_z")], "policy-1"), base,
    "同じ件数でも資料版が変われば変わる");
});

test("辞書が空なら、質問を変えず候補も作らない", () => {
  assert.equal(emptyTermDictionary.revision, "none");
  assert.deepEqual(emptyTermDictionary.terms, []);
  const result = applyExplicitTerms("さくらラボの仕事", emptyTermDictionary);
  assert.equal(result.text, "さくらラボの仕事");
  assert.deepEqual(result.edits, []);
  assert.deepEqual(correctionCandidates({ base: "さくらラボの仕事", dictionary: emptyTermDictionary }), []);
});
