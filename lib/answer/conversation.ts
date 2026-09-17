// 面談の場で使われる定型句。文全体を定型句とフィラーで消費できたときだけ返す。
// 実質的な質問が続く場合は消費できず、通常の検索とLLMの回答路へ渡る。
type Phrase = [RegExp, string];

const greetingReply = "こんにちは。気になることを聞いてください。";
const thanksReply = "どういたしまして。ほかにも気になることがあれば聞いてください。";
const farewellReply = "ありがとうございました。またいつでもお話しください。";
const apologyReply = "いえ、大丈夫です。気になることを聞いてください。";
const acknowledgementReply = "はい。続けて、気になることを聞かせてください。";
const neutralReply = "はい。気になることを聞いてください。";

// 同じ位置で長い候補を先に置く。「おはよう」より「おはようございます」を先に試す。
const phrases: Phrase[] = [
  [/^(?:おはようございます|おはよう|こんにちは|こんにちわ|こんばんは|こんばんわ|初めまして|はじめまして|始めまして|今日は|今日も|本日は|本日も)/u, greetingReply],
  [/^(?:よろしくお願い(?:いたします|致します|申し上げます|します)|よろしく頼みます|よろしく)/u, greetingReply],
  [/^(?:お願い(?:いたします|致します|申し上げます|します))/u, greetingReply],
  [/^(?:お世話になっております|お世話になります|お世話様です|お世話さまです)/u, greetingReply],
  [/^お疲れ(?:さまでした|様でした)/u, farewellReply],
  [/^お疲れ(?:さまです|様です|さま|様)/u, greetingReply],
  [/^(?:どうも)?ありがとう(?:ございました|ございます)?/u, thanksReply],
  [/^(?:感謝します|感謝いたします|助かりました|助かります)/u, thanksReply],
  [/^(?:申し訳ございません|申し訳ありません|すみません|すいません|ごめんなさい|失礼しました)/u, apologyReply],
  [/^(?:さようなら|さよなら|ではまた|またね|バイバイ|お先に失礼します)/u, farewellReply],
  [/^(?:失礼します|失礼いたします)/u, neutralReply],
  [/^(?:なるほどですね|なるほど|そうなんですね|そうですね|そうですか|そうなんだ|へえ|ふむ|わかりました|分かりました|了解しました|了解です|了解|承知しました|承知です|大丈夫です|オッケー|OK)/u, acknowledgementReply],
  // 「ええと」はフィラーなので、後ろに続く語で「ええ」単独と区別する。
  [/^(?:ええ(?!と|っ|ー|-)|はい|うん)/u, acknowledgementReply],
];

// 発話の頭に付くフィラー。長い候補を先に置き、「ええと」を「ええ」で切らない。
const filler = /^(?:あのー|あの|あー|あ|えーっと|ええっと|ええーと|えーと|ええと|えっと|えー|ええ|え|うーん|うん|そのー|その|なんか|まあ)[ー〜~]*/u;

function takePhrase(text: string): { rest: string; reply: string } | null {
  for (const [pattern, reply] of phrases) {
    const match = pattern.exec(text);
    // 語尾の伸ばし（こんにちはー、よろしく〜）は同じ発話として扱う。
    if (match) return { rest: text.slice(match[0].length).replace(/^[ー〜~]+/u, ""), reply };
  }
  return null;
}

// フィラーだけを取り除いた残り。発話の先頭・末尾に付いたフィラーの判定に使う。
export function stripFillers(text: string): string {
  let rest = text;
  for (;;) {
    const match = filler.exec(rest);
    if (!match) return rest;
    rest = rest.slice(match[0].length);
  }
}

// フィラーを1つずつ剥がし、剥がした先に定型句があれば返す。
// 「ありがとう」の「あ」のように語の先頭を食わないよう、剥がした直後だけを定型句として見る。
function takeAfterFillers(text: string): { rest: string; reply: string } | null {
  let rest = text;
  for (;;) {
    const match = filler.exec(rest);
    if (!match) return null;
    rest = rest.slice(match[0].length);
    const phrase = takePhrase(rest);
    if (phrase) return phrase;
  }
}

// 既知の定型句とフィラーで全文を消費できる場合だけ、最後の句に応じて返す。
export function conversationReply(message: string): string | null {
  let text = message.normalize("NFKC").replace(/[\s、。,.!?！？]+/gu, ""), reply: string | null = null;
  while (text) {
    const phrase = takePhrase(text);
    if (phrase) { text = phrase.rest; reply = phrase.reply; continue; }
    const next = takeAfterFillers(text);
    if (next) { text = next.rest; reply = next.reply; continue; }
    // フィラーだけで終わる発話は、直前までの定型句で確定する。
    if (reply !== null && stripFillers(text) === "") break;
    return null;
  }
  return reply;
}

export function asksForName(message: string): boolean {
  return /名前|名称|何という|なんという|何ていう|なんていう|何と呼|なんと呼|何て呼|なんて呼/.test(message);
}

// 履歴が無いのに、対象を省いた追質問だけが届いた発話。対象を一つ確認する。
// 「いつから働けますか」のような対象のある質問は含めない（先頭から全体が一致するときだけ）。
const subjectFollowUp = new RegExp(
  "^(?:(?:もっと|もう少し|さらに|ちょっと)?(?:具体的|詳しく|くわしく)(?:に)?(?:教えて|説明して)?(?:ください|お願いします|お願い)?"
  + "|(?:つまり|要するに|というと|どういうこと|どういう意味)(?:ですか|でしょうか)?"
  + "|(?:それは|それが|これは)?(?:いつ|どこ|どれ|どのへん)(?:ですか|でしょうか))$", "u");
const followUpOpening = /^(?:もっと|もう少し|さらに|ちょっと|つまり|要するに|というと|どういうこと|どういう意味|それは|それが|これは)/u;

export function asksForSubjectFollowUp(message: string): boolean {
  const text = message.normalize("NFKC").replace(/[s、。,.!?？]+$/gu, "");
  if (!followUpOpening.test(text)) return false;
  return subjectFollowUp.test(text);
}
