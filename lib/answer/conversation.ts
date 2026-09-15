const phrases: [RegExp, string][] = [
  // 「本日は」「今日も」は面談の場の挨拶。実質問が続く場合は全文を消費できないので検索へ渡る。
  [/^(?:こんにちは|こんにちわ|今日は|今日も|本日は|本日も|こんばんは|おはよう(?:ございます)?|よろしく(?:お願いします|お願いいたします))[ー〜~]*/u,
    "こんにちは。気になることを聞いてください。"],
  [/^お世話に(?:なります|なっております)[ー〜~]*/u,
    "こちらこそ、よろしくお願いします。気になることを聞いてください。"],
  [/^(?:どうも)?ありがとう(?:ございます|ございました)?[ー〜~]*/u,
    "どういたしまして。ほかにも気になることがあれば聞いてください。"],
  [/^(?:さようなら|さよなら|ではまた|またね|バイバイ)[ー〜~]*/u,
    "ありがとうございました。またいつでもお話しください。"],
];

function takePhrase(text: string): { rest: string; reply: string } | null {
  for (const [pattern, reply] of phrases) {
    const match = pattern.exec(text);
    if (match) return { rest: text.slice(match[0].length), reply };
  }
  return null;
}

// 既知の前置きと定型句で全文を消費できる場合だけ、最後の句に応じて返す。
export function conversationReply(message: string): string | null {
  let text = message.normalize("NFKC").replace(/[\s、。,.!?]+/gu, ""), reply: string | null = null;
  while (text) {
    // 「ありがとう」の「あ」を先にフィラーとして剥がさない。
    let phrase = takePhrase(text);
    if (!phrase) {
      // 長い候補を先に置く。「ええと」を「え」で切らない。
      const filler = /^(?:あの|あ|えっと|ええと|えーと|ええ|え|うーん|うん)[ー〜~]*/u.exec(text);
      if (filler) phrase = takePhrase(text.slice(filler[0].length));
    }
    if (!phrase) return null;
    text = phrase.rest; reply = phrase.reply;
  }
  return reply;
}

export function asksForName(message: string): boolean {
  return /名前|名称|何という|なんという|何ていう|なんていう|何と呼|なんと呼|何て呼|なんて呼/.test(message);
}
