// #7 音声入力の正規化。実在しない名称だけを使い、経路と回数を確認する。
import test from "node:test";
import assert from "node:assert/strict";
import { WebSpeechRecognizer } from "../lib/voice/input/webspeech.ts";
import { hasNoQuestionText, mechanicalNormalize } from "../lib/voice/input/mechanical.ts";
import { applyExplicitTerms, correctionCandidates, preservesCriticalTokens } from "../lib/voice/input/terms.ts";
import { normalizeVoiceInput } from "../lib/voice/input/normalize.ts";
import type { SpeechRecognitionConstructor, SpeechRecognitionLike } from "../lib/voice/input/types.ts";

const dictionary = { revision: "t1", terms: [
  { termId: "r1:term:0", canonical: "Sakura Lab", aliases: ["さくらラボ"], sourceRevision: "r1" },
  { termId: "r2:term:1", canonical: "AI", aliases: ["えーあい"], sourceRevision: "r2" }
] };

class FakeRecognition {
  lang = ""; continuous = false; interimResults = false; maxAlternatives = 1; processLocally?: boolean;
  phrases?: unknown[]; onresult: ((event: never) => void) | null = null; onerror: ((event: never) => void) | null = null;
  onend: (() => void) | null = null; stopped = 0;
  start(): void {}
  stop(): void { this.stopped++; }
  abort(): void {}
}

test("ブラウザー認識は、実際に返った3候補を順位ごとにまとめて返す", async () => {
  let current: FakeRecognition | null = null;
  const constructor = function () { current = new FakeRecognition(); return current; } as unknown as SpeechRecognitionConstructor;
  const recognizer = new WebSpeechRecognizer({ mode: "browser-cloud", constructor, callbacks: { interim: () => {}, failure: () => {} } });
  recognizer.listen();
  recognizer.begin("u1");
  assert.equal(current!.maxAlternatives, 3, "対応時は最大3件を要求する");
  const result = (values: string[]) => ({ isFinal: true, length: values.length,
    ...Object.fromEntries(values.map((value, index) => [index, { transcript: value }])) });
  current!.onresult!({ resultIndex: 0, results: { length: 1, 0: result(["さくらラボの件です", "さくらんぼの件です", "さくらラボの件"]) } } as never);
  const finished = recognizer.finish("u1", null, new AbortController().signal);
  current!.onend?.();
  const value = await finished;
  assert.equal(value.text, "さくらラボの件です");
  assert.deepEqual(value.alternatives, ["さくらラボの件です", "さくらんぼの件です", "さくらラボの件"], "返った候補だけを返す");
});

test("軽い整形は意味を変えず、引用と語中を壊さない", () => {
  assert.equal(mechanicalNormalize("えーと、会社員時代の経験を教えて").text, "会社員時代の経験を教えて");
  assert.equal(mechanicalNormalize("あの会社では何を担当した？").text, "あの会社では何を担当した？");
  assert.equal(mechanicalNormalize("行きたくないわけではない").text, "行きたくないわけではない");
  assert.equal(mechanicalNormalize("2018年、いや2019年でしたか？").text, "2018年、いや2019年でしたか？");
  assert.equal(mechanicalNormalize("「昨日、えーと、それと」と聞いた").text, "「昨日、えーと、それと」と聞いた");
  assert.equal(mechanicalNormalize("会 社 員 経 験").text, "会社員経験");
  assert.equal(hasNoQuestionText(mechanicalNormalize("えーと").text), true, "フィラーだけは質問にしない");
});

test("明示された一意の読みだけを置き換え、語中と複数対応は候補に回す", () => {
  assert.equal(applyExplicitTerms("えーあいをどう使った？", dictionary).text, "AIをどう使った？");
  assert.equal(applyExplicitTerms("えーあいする", dictionary).text, "えーあいする", "語中は置き換えない");
  const ambiguous = { revision: "t2", terms: [
    { termId: "r1:term:0", canonical: "Sakura Lab", aliases: ["さくら"], sourceRevision: "r1" },
    { termId: "r2:term:1", canonical: "Sakura Studio", aliases: ["さくら"], sourceRevision: "r2" }
  ] };
  assert.equal(applyExplicitTerms("さくらの件", ambiguous).text, "さくらの件", "対応が一意でない別名は書き換えない");
  assert.ok(correctionCandidates({ base: "さくらの件", dictionary: ambiguous }).length >= 1, "候補には残す");
  assert.equal(preservesCriticalTokens("2018年、いや2019年でしたか？", "2019年でしたか？"), false, "年を落とす候補は採用しない");
  assert.equal(preservesCriticalTokens("えーあいを使った", "AIを使った"), true);
});

test("補正JEVは候補があるときだけ1回、段数と時間の枠を残せないときは行わない", async () => {
  let calls = 0;
  const judge = { evaluate: async (_purpose: unknown, questions: Record<string, unknown>, state: unknown) => {
    calls++;
    const candidates = (state as { correction_candidates: { id: string; text: string }[] }).correction_candidates;
    const chosen = candidates.find(candidate => candidate.text.includes("Sakura Lab")) ?? candidates[0];
    return { answers: { correction_choice: { type: "choice" as const, choice: chosen.id, confidence: .95 },
      [`${chosen.id}_preserves`]: { type: "noul" as const, value: .9 } } };
  } };
  const deps = { policy: undefined, dictionary, judge, history: [], timeoutMs: 1_500, remainingMs: 60_000, reserveMs: 6_000, stagesRemaining: 3 };
  const adopted = await normalizeVoiceInput({ text: "Sakura Labの件、えと、教えて", origin: "voice", alternatives: ["SakuraLabの件、教えて"] },
    deps, new AbortController().signal);
  assert.equal(calls, 1, "補正JEVは1回だけ");
  assert.equal(adopted.jevStages, 1, "採用しなくても段数を数える");
  assert.equal(adopted.resolution, "jev");
  assert.equal(adopted.effectiveQuestion, "SakuraLabの件、教えて");
  assert.equal(adopted.edited, true);
  const gated = await normalizeVoiceInput({ text: "Sakura Labの件、えと、教えて", origin: "voice", alternatives: ["SakuraLabの件、教えて"] },
    { ...deps, stagesRemaining: 1 }, new AbortController().signal);
  assert.equal(gated.jevStages, 0, "最終点検の枠を残せないときは補正しない");
  const manual = await normalizeVoiceInput({ text: "えーと、会社員時代の経験を教えて", origin: "manual" }, deps, new AbortController().signal);
  assert.equal(manual.effectiveQuestion, "えーと、会社員時代の経験を教えて", "手入力はフィラーを削らない");
  assert.equal(manual.jevStages, 0);
  const blocked = await normalizeVoiceInput({ text: "さくらラボの件", origin: "voice" },
    { ...deps, policy: { revision: "x", matches: (text: string) => text.includes("さくら"), matchedRuleIds: () => ["r"], mask: () => "［非表示の内容］" } },
    new AbortController().signal);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.displayQuestion, "［非表示の内容］");
});

test("補正JEVの失敗・期限では、補正だけをやめて原質問で続く", async () => {
  const failing = { evaluate: async () => { throw new Error("jev_down"); } };
  const deps = { dictionary, judge: failing, history: [], timeoutMs: 1_500, remainingMs: 60_000, reserveMs: 6_000, stagesRemaining: 3 };
  const failed = await normalizeVoiceInput({ text: "Sakura Labの件、えと、教えて", origin: "voice", alternatives: ["SakuraLabの件、教えて"] },
    deps, new AbortController().signal);
  assert.equal(failed.jevStages, 1, "呼んだ回は段数として数える");
  assert.equal(failed.resolution, "kept");
  assert.equal(failed.effectiveQuestion, "Sakura Labの件、えと、教えて", "原文を維持して本体を続ける");
  // 期限で戻れない判定器（bindingはsignalを受けない）でも、上限で打ち切って原文で続く。
  const hanging = { evaluate: () => new Promise<never>(() => {}) };
  const timedOut = await normalizeVoiceInput({ text: "Sakura Labの件、えと、教えて", origin: "voice", alternatives: ["SakuraLabの件、教えて"] },
    { ...deps, judge: hanging, timeoutMs: 20 }, new AbortController().signal);
  assert.equal(timedOut.effectiveQuestion, "Sakura Labの件、えと、教えて");
  assert.equal(timedOut.jevStages, 1, "打ち切っても1回として数える");
});

test("中止は正規化の途中でも伝わり、結果を返さない", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stopped"));
  await assert.rejects(normalizeVoiceInput({ text: "Sakura Labの件", origin: "voice" },
    { dictionary, history: [], timeoutMs: 1_500, remainingMs: 60_000, stagesRemaining: 3 }, controller.signal), /stopped/);
});

test("機械整形は冪等で、連続するフィラーも1回で揃う", () => {
  const examples = ["えーと、えっと、会社員時代の経験を教えて", "えーと、会社員時代の経験を教えて", "昨日、えーと、それと",
    "「昨日、えーと、それと」と聞いた", "あの会社では何を担当した？", "会 社 員 経 験", "えーと", "2018年、いや2019年でしたか？",
    "まあまあ得意でしたか？", "1日に2〜3時間"];
  for (const text of examples) {
    const once = mechanicalNormalize(text).text;
    assert.equal(mechanicalNormalize(once).text, once, `二度目で変わらない: ${text}`);
  }
  assert.equal(mechanicalNormalize("えーと、えっと、会社員時代の経験を教えて").text, "会社員時代の経験を教えて", "連続するフィラーを1回で揃える");
  assert.equal(mechanicalNormalize("えーと").text, "");
});

test("引用の中は、フィラーも用語の置き換えもしない", () => {
  const quoted = { revision: "t3", terms: [
    { termId: "r1:term:0", canonical: "Sakura Lab", aliases: ["さくらラボ"], sourceRevision: "r1" }] };
  assert.equal(applyExplicitTerms("「さくらラボ」と書いてあった", quoted).text, "「さくらラボ」と書いてあった");
  assert.equal(applyExplicitTerms("さくらラボの件", quoted).text, "Sakura Labの件", "外側は置き換える");
  assert.equal(applyExplicitTerms("「さくらラボ」と書いてあった", quoted).edits.length, 0, "引用の中だけなら編集として数えない");
  assert.equal(applyExplicitTerms("「さくらラボ」と、さくらラボの件", quoted).text, "「さくらラボ」と、Sakura Labの件",
    "引用の後ろの通常文は置き換え、引用はそのまま残す");
  assert.equal(applyExplicitTerms("さくらラボの件と「さくらラボ」", quoted).text, "Sakura Labの件と「さくらラボ」",
    "引用の前の通常文も置き換える");
  assert.equal(mechanicalNormalize("「えーと、」と言った").text, "「えーと、」と言った");
});

test("引用の中だけの別名では、補正として記録しない", async () => {
  const quoted = { revision: "t4", terms: [
    { termId: "r1:term:0", canonical: "Sakura Lab", aliases: ["さくらラボ"], sourceRevision: "r1" }] };
  const envelope = await normalizeVoiceInput({ text: "「さくらラボ」と書いてあった", origin: "voice" },
    { dictionary: quoted, history: [], timeoutMs: 1_500, remainingMs: 60_000, stagesRemaining: 3 }, new AbortController().signal);
  assert.equal(envelope.edited, false, "引用の中だけでは「整えました」を出さない");
  assert.equal(envelope.effectiveQuestion, "「さくらラボ」と書いてあった");
});
