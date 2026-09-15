import test from "node:test";
import assert from "node:assert/strict";
import { answer } from "../lib/answer/engine.ts";
import { looksLikeQuestion, validateSegment } from "../lib/answer/guard.ts";
import { KnowledgeRepository } from "../lib/knowledge/repository.ts";
import { FakeVector, LocalDatabase, embedding, fixture, setup } from "./helpers.ts";
import type { AnswerProvider, ChatEvent, Diagnostic, Evidence, ModelPayload } from "../lib/types.ts";

const textOf = (events: ChatEvent[]) => events.flatMap(event => event.type === "text" ? [event.text] : []).join("");

const conversational = (text: string): ModelPayload =>
  ({ segments: [{ kind: "conversational", text, evidenceIds: [] }], answerability: "answerable", confidence: "high" });

type Reply = (evidence: Evidence[]) => ModelPayload;

// 資料の有無と、モデルが返す候補を差し替えてエンジンの経路だけを確かめる。
async function run(options: { question: string; empty?: boolean; replies: Reply[]; verify?: boolean }) {
  const source = options.empty ? { db: new LocalDatabase(), vector: new FakeVector() } : await setup();
  const calls: string[] = [], diagnostics: Diagnostic[] = [];
  let index = 0;
  const provider: AnswerProvider = {
    async *stream(input) {
      calls.push(input.purpose ?? "answer");
      const payload = input.purpose === "verify" ? input.candidate! : options.replies[Math.min(index++, options.replies.length - 1)](input.evidence);
      for (const segment of payload.segments) yield { type: "segment", segment };
      yield { type: "complete", payload, usage: { input: 10, output: 10 } };
    }
  };
  const events = await Array.fromAsync(answer({ mode: "meeting_text", message: options.question, history: [] }, {
    repository: new KnowledgeRepository(source.db, fixture.ownerId), vector: source.vector, embedding, provider,
    diagnostics: (diagnostic: Diagnostic) => diagnostics.push(diagnostic)
  }, new AbortController().signal));
  source.db.close();
  return { events, calls, diagnostics };
}

// 定型リストに無い挨拶。この経路だけがLLMの柔軟な応答路を通る。
const unlisted = "お忙しいところ恐れ入ります";

test("根拠が無く質問形でもない発話は、LLMの会話応答をそのまま返す", async () => {
  const { events, calls, diagnostics } = await run({ question: unlisted, empty: true,
    replies: [() => conversational("いいえ、大丈夫です。気になることを聞いてください。")] });
  assert.equal(textOf(events), "いいえ、大丈夫です。気になることを聞いてください。");
  assert.deepEqual(calls, ["answer"]);
  assert.ok(diagnostics.some(diagnostic => diagnostic.code === "conversation_reply"));
});

test("根拠が無く質問形の発話は、従来どおり不明を返し生成を呼ばない", async () => {
  const { events, calls } = await run({ question: "チームの人数はどのくらいですか。", empty: true, replies: [() => conversational("はい。")] });
  assert.equal(textOf(events), "その点はまだ確認できていません。面談で本人に聞いてみてください。");
  assert.deepEqual(calls, []);
  assert.ok(events.some(event => event.type === "done" && event.answerability === "unknown"));
});

test("資料があっても、質問形の入力に会話応答を返させない", async () => {
  const grounded: Reply = evidence => ({
    segments: [{ kind: "grounded_synthesis", text: "小さく試して、使う人の声を聞くことを大切にしています。", evidenceIds: [evidence[0].id],
      claims: [{ text: "小さく試して、使う人の声を聞くことを大切にしています。", kind: "statement",
        supports: [{ evidenceId: evidence[0].id, quote: "早い段階で小さく試して、使う人の声を聞くことを大切にしています。" }] }] }],
    answerability: "answerable", confidence: "high"
  });
  const { events, calls, diagnostics } = await run({ question: "仕事で大切にしていることは何ですか。",
    replies: [() => conversational("はい、承知しました。"), grounded] });
  assert.deepEqual(calls, ["answer", "answer", "verify"]);
  assert.ok(diagnostics.some(diagnostic => diagnostic.code === "repair_attempted"));
  assert.equal(textOf(events), "小さく試して、使う人の声を聞くことを大切にしています。");
  assert.ok(!textOf(events).includes("承知しました"));
});

test("質問形でない資料ありの入力では、会話応答を校閲なしで返す", async () => {
  const { events, calls } = await run({ question: unlisted, replies: [() => conversational("いいえ、大丈夫です。")] });
  assert.equal(textOf(events), "いいえ、大丈夫です。");
  assert.deepEqual(calls, ["answer"]);
});

test("会話応答でも、数値・固有名詞・本人の事実は認めない", () => {
  const evidence: Evidence[] = [{ id: "ev", content: "私は要件整理を担当しました。", documentId: "doc", revisionId: "rev",
    contentHash: "hash", entities: ["リーフ検証プロジェクト"], title: "担当", rank: 0, kind: "chunk" }];
  const check = (text: string, question = unlisted) => validateSegment({ kind: "conversational", text, evidenceIds: [] }, evidence, true, question);
  assert.equal(check("はい、続けます。気になることを聞いてください。").ok, true);
  for (const text of ["2022年は5人でした。", "リーフ検証プロジェクトを担当しました。", "年収は1,000万円です。", "あ".repeat(121)])
    assert.equal(check(text).ok, false, text);
  // 質問形の入力では、会話応答そのものを認めない。
  assert.equal(check("はい、承知しました。", "週5日勤務は可能ですか").ok, false);
  // 根拠を宣言する会話応答も認めない。
  assert.equal(validateSegment({ kind: "conversational", text: "はい。", evidenceIds: ["ev"] }, evidence, true, unlisted).ok, false);
});

test("質問形の判定は挨拶や相槌を拾わない", () => {
  for (const message of ["お忙しいところ恐れ入ります", "お世話になっております", "どうもありがとうございます", "いつもお世話さまです", "失礼します", "はい、わかりました", "本日はよろしくお願いします"])
    assert.equal(looksLikeQuestion(message), false, message);
  for (const message of ["学生時代どんな方でしたか", "週5日勤務は可能ですか", "チームの人数はどのくらいですか", "経歴を教えてください", "失敗した経験はありますか", "いつから働けますか"])
    assert.equal(looksLikeQuestion(message), true, message);
});
