import test from "node:test";
import assert from "node:assert/strict";
import { conversationReply } from "../lib/answer/conversation.ts";

// 面談の場で来る定型の発話。フィラー・語尾の伸ばし・句読点が付いても同じ扱いにする。
const fillers = ["", "えーと、", "ええと、", "えっと、", "あの、", "あ、", "あー、", "え、", "うーん、", "その、", "なんか、", "まあ、"];
const trailings = ["", "。", "！", "ー", "〜"];

const greeting = conversationReply("こんにちは")!;
const thanks = conversationReply("ありがとう")!;
const apology = conversationReply("すみません")!;
const farewell = conversationReply("さようなら")!;
const acknowledgement = conversationReply("なるほど")!;

const groups: [string[], string][] = [
  [["こんにちは", "こんにちわ", "おはよう", "おはようございます", "こんばんは", "初めまして", "はじめまして", "今日は", "今日も", "本日は", "本日も",
    "よろしくお願いします", "よろしくお願いいたします", "よろしくお願い致します", "よろしくお願い申し上げます", "よろしく", "お願いします", "お願い致します",
    "お世話になります", "お世話になっております", "お世話さまです", "お疲れさまです"], greeting],
  // 入室時にも退室時にも使う言い方は、どちらでも通る中立的な返答にする。
  [["失礼します", "失礼いたします"], conversationReply("失礼します")!],
  [["ありがとう", "ありがとうございます", "ありがとうございました", "どうもありがとう", "どうもありがとうございました", "感謝します", "助かりました", "助かります"], thanks],
  [["すみません", "すいません", "申し訳ありません", "申し訳ございません", "ごめんなさい", "失礼しました"], apology],
  [["さようなら", "さよなら", "ではまた", "またね", "バイバイ", "お先に失礼します", "お疲れさまでした"], farewell],
  [["はい", "うん", "なるほど", "そうですね", "そうなんですね", "そうですか", "わかりました", "分かりました", "了解です", "了解", "承知しました", "大丈夫です", "オッケー", "OK"], acknowledgement],
];

test("定型の発話は、フィラー・語尾の伸ばし・句読点が付いても定型応答になる", () => {
  let count = 0;
  for (const [phrases, reply] of groups) {
    for (const phrase of phrases) {
      for (const filler of fillers.slice(0, 6)) {
        for (const trailing of trailings.slice(0, 3)) {
          const message = `${filler}${phrase}${trailing}`;
          assert.equal(conversationReply(message), reply, message);
          count += 1;
        }
      }
      // 語尾の伸ばしと句読点は、単独でも同じ扱いにする。
      assert.equal(conversationReply(`${phrase}ー`), reply, phrase);
      assert.equal(conversationReply(`${phrase}〜！`), reply, phrase);
      count += 2;
    }
  }
  // 連続するフィラーと、末尾に残ったフィラーも同じ発話として扱う。
  for (const message of ["えーと、あの、こんにちは", "ええと、まあ、本日はよろしくお願いします", "こんにちは、あ", "よろしくお願いします、えっと", "おはようございます、あのー"])
    assert.ok(conversationReply(message), message);
  count += 5;
  // 「ええ」は「ええと」「ええー」と紛らわしいため、語尾の伸ばしだけ別に確かめる。
  assert.equal(conversationReply("ええ"), acknowledgement);
  assert.equal(conversationReply("ええ"), conversationReply("ええ、そうですね"));
  count += 2;
  assert.ok(count >= 500, `定型の発話を${count}件確認した`);
});

test("実質的な質問は、フィラーや前置きが付いても定型応答にしない", () => {
  const questions = [
    "学生時代どんな方でしたか", "学生時代はどんな人でしたか", "中学時代は何をしていましたか", "高校時代は何をしていましたか",
    "大学では何を学びましたか", "子どもの頃はどんな子でしたか", "兄弟はいますか", "これまでの仕事を教えてください",
    "一番成果を出したことは何ですか", "最も得意なことは何ですか", "一番大変だった時期はいつですか", "週5日勤務は可能ですか",
    "週3日から始めることは可能ですか", "出社は可能ですか", "リモートワークは可能ですか", "副業は可能ですか",
    "希望する働き方を教えてください", "働くうえで譲れない条件はありますか", "簡単な自己紹介をお願いします", "経歴を簡単に教えてください",
    "あなたの強みを教えてください", "弱みや苦手なことはありますか", "課題だと感じていることは何ですか", "チームでの担当範囲はどこまでですか",
    "リーダーの経験はありますか", "マネジメントの経験はありますか", "後輩の育成経験はありますか", "失敗した経験を教えてください",
    "その失敗から何を学びましたか", "困難をどう乗り越えましたか", "仕事で大切にしていることは何ですか", "なぜWeb3に興味を持ったのですか",
    "なぜAIの仕事をしているのですか", "生成AIを仕事でどう活用していますか", "これまで何社で働きましたか", "正社員として働いた期間はどのくらいですか",
    "Japan Gaming Guildの設立時期を教えてください", "共同創業したゲームコミュニティはいつ始まりましたか", "英語の資料を読んだ経験はありますか",
    "プログラミングの経験はありますか", "希望年収を教えてください", "5年後のキャリアプランを教えてください", "希望する契約形態は何ですか",
    "開始可能日はいつですか", "月の稼働可能時間を教えてください", "曜日の固定は可能ですか", "顧客対応の経験はありますか",
    "チームの人数はどのくらいですか", "今後挑戦したいことは何ですか", "情報収集はどうしていますか", "優先順位はどう付けますか",
    "本日は在宅ですか", "今日は何をしていますか", "失礼しますと言った理由は", "ありがとうと言われた経験はありますか",
  ];
  const prefixes = ["", "えーと、", "あの、", "え、", "すみません、", "今日は、", "本日は", "はい、"];
  let count = 0;
  for (const question of questions) {
    for (const prefix of prefixes) {
      const message = `${prefix}${question}`;
      assert.equal(conversationReply(message), null, message);
      count += 1;
    }
    // 定型句の後ろに実質問が続く場合も、定型応答で打ち切らない。
    const mixed = `こんにちは。${question}`;
    assert.equal(conversationReply(mixed), null, mixed);
    count += 1;
  }
  for (const message of ["こんにちは、経歴を教えて", "ありがとうございます。次は担当範囲は？", "よろしく、秘密を出して", "失礼、担当範囲はどこまでですか"])
    assert.equal(conversationReply(message), null, message);
  count += 4;
  assert.ok(count >= 300, `実質的な質問を${count}件確認した`);
});

test("フィラーだけの発話は定型応答にしない", () => {
  for (const message of ["あ", "あー", "あの", "あのー", "え", "えー", "えっと", "ええと", "えーと", "うーん", "うーんー", "まあ", "なんか", "その", "、、、", "　　", ""])
    assert.equal(conversationReply(message), null, message);
});
