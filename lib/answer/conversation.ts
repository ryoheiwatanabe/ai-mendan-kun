// 発言全体が定型句の場合だけ返す。質問や本人についての主張を含む発言は検索へ渡す。
export function conversationReply(message: string): string | null {
  const text = message.normalize("NFKC").trim().replace(/[\s、。,.!！?？ー〜~]+$/u, "");
  if (/^(こんにちは|こんにちわ|こんばんは|おはよう(?:ございます)?|よろしく(?:お願いします|お願いいたします))$/u.test(text))
    return "こんにちは。気になることを聞いてください。";
  if (/^(?:どうも)?ありがとう(?:ございます|ございました)?$/u.test(text))
    return "どういたしまして。ほかにも気になることがあれば聞いてください。";
  if (/^(さようなら|さよなら|ではまた|またね|バイバイ)$/u.test(text))
    return "ありがとうございました。またいつでもお話しください。";
  return null;
}
