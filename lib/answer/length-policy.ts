import { asksForName } from "./conversation.ts";
import { condense } from "../knowledge/text.ts";
import type { LengthBudget } from "../types.ts";

// 通常は上限220字、一言・名前・日付確認などは上限80字、詳細は上限400字。
// 下限は設けない。40字で足りる回答を水増ししない。
const brief: LengthBudget = { mode: "brief", max: 80, target: 60 };
const normal: LengthBudget = { mode: "normal", max: 220, target: 140 };
export const detail: LengthBudget = { mode: "detail", max: 400, target: 260 };

// 明示の「50字以内」等を優先し、1..400へclampする。4桁は400へclamp。
const explicitDigits = /(\d+)\s*字(?:以内|以下|まで)/u;
const explicitShort = /(一言で|ひとことで)/u;
// 「具体的に」単独は詳細トリガーから除く。詳細要求は明示的な語のみ。
const explicitDetail = /(詳しく|詳細|理由と具体例|比較して|背景も|深く|じっくり)/u;
// 「詳しくなくてよい」等の否定を先に消費する。詳細と通常の両方を否定する場合がある。
const detailNegation =
  /(詳しく|詳細|具体的|深く)[^。！？]{0,8}(なくて|なく|不要|いらない|無し|なし|無用|要らない|要りません)|(なくて|なく|不要|いらない|無し|なし|要らない)[^。！？]{0,4}(詳しく|詳細|具体的|深く)/u;
// 名前を尋ねる質問・日付確認は最短の一言で答える。

function clamp(value: number): number {
  if (!Number.isFinite(value) || Number.isNaN(value)) return normal.max;
  return Math.max(1, Math.min(400, Math.trunc(value)));
}

// 質問本文だけから決める。LLM呼び出しを増やさない。
export function lengthPolicy(question: string): LengthBudget {
  const text = condense(question);
  const digits = explicitDigits.exec(text);
  if (digits) {
    const raw = Number(digits[1]);
    const max = clamp(raw >= 1000 ? 400 : raw);
    return {
      mode: max <= 80 ? "brief" : max > 220 ? "detail" : "normal",
      max,
      target: Math.max(1, Math.min(max, Math.floor(max * 0.75)))
    };
  }
  const negated = detailNegation.test(text);
  if (negated) return normal;
  if (asksForName(text) && !explicitDetail.test(text)) return brief;
  if (explicitShort.test(text)) return brief;
  if (explicitDetail.test(text)) {
    // 数字指定なしで詳細指定がある場合は詳細（上限400）。
    return { ...detail, max: 400 };
  }
  return normal;
}

// 表示・読み上げ用の最終本文のUnicodeコードポイント数。書記素数・トークン数ではない。
export function measureText(text: string): number {
  return Array.from(text).length;
}

export function withinBudget(text: string, budget: LengthBudget): boolean {
  return measureText(text) <= budget.max;
}

export type { LengthBudget as Budget };
