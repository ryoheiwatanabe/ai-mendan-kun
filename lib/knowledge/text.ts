import type { Evidence } from "../types.ts";
import { asksForName } from "../answer/conversation.ts";

// 音声認識は語中にも空白を入れる（例:「年 収」「私 生活」）。判定の前に空白を詰める。
export function condense(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, "");
}

export function normalize(text: string): string {
  return text.normalize("NFKC").replace(/\r\n?/g, "\n").trim();
}

// 音声認識は語の切れ目にも空白を入れる（例:「会 社 員 経 験」「苦 手 な の は ？」）。
// 日本語の文字と句読点の間の空白だけを詰める。英単語の区切りと英数字の語は残す。
const japanese = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}ー、。！？";
const betweenJapanese = new RegExp(`(?<=[${japanese}])\\s+(?=[${japanese}])`, "gu");

// 意味解釈に渡す文。日本語の語間へ入った空白だけを詰め、英数字の語はそのまま残す。
export function collapseJapaneseSpaces(text: string): string {
  return text.replace(betweenJapanese, "");
}

// 日本語は空白に依存しない文字bigram、英数は単語。同じ処理を投入と検索に使用する。
export function searchTerms(text: string): string[] {
  const input = normalize(collapseJapaneseSpaces(text)).toLowerCase();
  const terms: string[] = input.match(/[a-z0-9][a-z0-9_+-]*/g) ?? [];
  for (const match of input.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu)) {
    const chars = Array.from(match[0]);
    if (chars.length === 1) terms.push(chars[0]);
    for (let i = 0; i < chars.length - 1; i++) terms.push(chars[i] + chars[i + 1]);
  }
  return [...new Set(terms)];
}

export function ftsQuery(text: string): string {
  return searchTerms(text).slice(0, 72).map(term => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

export function searchQuery(question: string, history: { role: string; content: string }[]): string {
  // 音声認識の空白入りでも、下の言い回しの判定が効くように空白を詰めて調べる。
  const text = condense(question);
  // 経歴・職歴の質問は、会社名や在籍期間の見出しへ届かせる語を足す。
  // 「会社員経験」のような一般的な言い方だけでは、社名・期間の見出しに当たりにくい。
  if (/自己紹介|経歴|職歴|会社員|勤務|どんな(?:仕事|こと)をしてきた/.test(text))
    return `${question}\n経歴 仕事内容 担当 経験 活動 プロフィール 会社 勤務先 在籍 入社 退社`.slice(0, 4000);
  if (!asksForName(question) && !/(その|それ|当時|そこで|もう少し|詳しく|ほかには|他には|具体的|現在|今は|その後)/.test(text)) return question;
  // assistant発言は照応先を探す手掛かりだけに使う。回答根拠は現行の承認済み本文から取り直す。
  const previous = history.slice(-2).reverse().map(turn => turn.content.slice(-900)).join("\n");
  return `${question}\n${previous}`.slice(0, 4000);
}

export function sentences(text: string): string[] {
  return normalize(text).split(/(?<=[。！？!?])\s*|\n+/u).map(value => value.trim()).filter(Boolean);
}

export function chunkMarkdown(text: string): { title: string; content: string }[] {
  const output: { title: string; content: string }[] = [];
  let title = "プロフィール";
  let buffer = "";
  const flush = () => { if (buffer.trim()) output.push({ title, content: buffer.trim() }); buffer = ""; };
  for (const part of normalize(text).split(/\n\s*\n|(?=^#{1,6}\s)/m)) {
    let unit = part.trim();
    if (/^#{1,6}\s/.test(unit)) {
      flush();
      const [heading, ...rest] = unit.split("\n");
      title = heading.replace(/^#{1,6}\s+/, ""); unit = rest.join("\n").trim();
    }
    if (!unit) continue;
    if (unit.length > 800) throw new Error("一つの段落は800文字以内にしてください。但し書きは同じ段落に残してください。");
    if (buffer.length + unit.length > 1800) flush();
    buffer += (buffer ? "\n\n" : "") + unit;
  }
  flush();
  return output;
}

export function approvedUnits(content: string): string[] {
  return normalize(content).split(/\n\s*\n|\n(?=#{1,6}\s)/).map(unit => unit.replace(/^#{1,6}[^\n]*(?:\n|$)/, "").trim()).filter(Boolean);
}

// 文書全体に付くentitiesだけでは所属先を断定しない。同じ承認済み見出し内の名前に限定する。
export function approvedNames(item: Evidence): string[] {
  if (item.kind !== "chunk") return [];
  const title = normalize(item.title);
  return [...new Set(item.entities.map(normalize).filter(name => {
    if (name.length < 2) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // ハイフンやピリオドは名称内部にも使われるので、区切り扱いしない。
    const boundary = "[\\s()\\[\\]{}「」『』【】〈〉《》:、,/|]";
    return new RegExp(`(?:^|${boundary})${escaped}(?=$|${boundary})`, "u").test(title);
  }))];
}

export async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
}
