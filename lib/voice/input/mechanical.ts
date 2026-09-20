import { collapseJapaneseSpaces } from "../../knowledge/text.ts";

// 音声認識の直後に、追加のAIなしで行う軽い整形。同じ入力に二度当てても結果は変わらない。
// 質問の厳しさ・否定・程度・数字は変えない。ここで直すのは空白と、明確なフィラーだけ。
export const normalizationVersion = "voice-input-v1";

export type InputOrigin = "voice" | "manual";
// 決着の種類。none=変更なし、mechanical=空白とフィラーだけ、dictionary=明示の別名・読み、
// jev=JEVで選んだ候補、kept=候補はあったが原文を維持、unresolved=曖昧なので確認へ、blocked=非表示対象。
export type InputResolution = "none" | "mechanical" | "dictionary" | "jev" | "kept" | "unresolved" | "blocked";
// どの範囲をどの規則で変えたか。処理の間だけ持ち、保存しない。
export type InputEdit = { rule: string; before: string; after: string };

// 変えた範囲だけを取り出す。前後で同じ部分は含めない。
function changedFragment(rule: string, before: string, after: string): InputEdit {
  let head = 0;
  const limit = Math.min(before.length, after.length);
  while (head < limit && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < limit - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  return { rule, before: before.slice(head, before.length - tail), after: after.slice(head, after.length - tail) };
}

// 発話の先頭か、句読点の直後にあるフィラーだけを、後ろが句読点か文末のときに削る。
// 許可リストは小さく保つ。「あの会社」の指示語や「えーあい」のような語の一部は削らない。
const fillerTokens = ["えーっと", "えーと", "えっと", "ええと", "あのー", "あのう", "んーと", "うーんと", "そのー", "あの", "えー", "あー"];
const separators = "[、。！!？?，．\n]";
const openingQuotes = "「『（";
const closingQuotes = "」』）";

// 断片がフィラーだけでできているか。許可リストの語を前から取り除いて空になれば真。
function fillerOnly(content: string): boolean {
  let rest = content.replace(/[ \t\u3000]/gu, "");
  for (const token of fillerTokens) while (rest.startsWith(token)) rest = rest.slice(token.length);
  return rest === "";
}

// 句読点で区切った断片ごとに見る。断片の中身がフィラーだけで、発話の先頭か句読点の直後なら、
// その断片ごと落とす（「えーと、会社員…」→「会社員…」）。引用符の中では落とさない。
export function stripFillers(text: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  const kept: string[] = [];
  let quoted = 0;
  for (const [index, part] of text.split(new RegExp(`(?<=${separators})`, "u")).entries()) {
    const content = part.replace(new RegExp(separators, "gu"), "").trim();
    // 先頭のフィラーを落とした後も、続くフィラーは「発話の先頭」として扱う（1回で揃える）。
    const atBoundary = kept.length === 0 || new RegExp(`${separators}$`, "u").test(kept.at(-1) ?? "");
    if (quoted === 0 && atBoundary && content && fillerOnly(content)) { removed.push(content); continue; }
    for (const char of part) {
      if (openingQuotes.includes(char)) quoted++;
      else if (closingQuotes.includes(char)) quoted = Math.max(0, quoted - 1);
    }
    kept.push(part);
  }
  return { text: kept.join(""), removed };
}

// 前後の空白・改行コード・日本語の文字間の空白を直し、明確なフィラーを削る。
export function mechanicalNormalize(input: string): { text: string; edits: InputEdit[] } {
  const edits: InputEdit[] = [];
  const step = (rule: string, value: string, next: string) => {
    if (next !== value) edits.push(changedFragment(rule, value, next));
    return next;
  };
  let text = input;
  text = step("newline", text, text.replace(/\r\n?/gu, "\n"));
  text = step("trim", text, text.trim());
  // 日本語の文字間にSTTが入れた空白だけを詰める。英数字の語間は残す。
  text = step("japanese_spaces", text, collapseJapaneseSpaces(text));
  text = step("repeat_spaces", text, text.replace(/[ \t\u3000]{2,}/gu, " "));
  const filled = stripFillers(text);
  text = step("filler", text, filled.text);
  return { text: text.trim(), edits };
}

// 手入力の最小整形。空白と改行だけを整え、フィラー除去や語の置き換えは行わない。
// 厳しい質問を面談向けに丸めない。
export function minimalNormalize(input: string): { text: string; edits: InputEdit[] } {
  const edits: InputEdit[] = [];
  const step = (rule: string, value: string, next: string) => {
    if (next !== value) edits.push(changedFragment(rule, value, next));
    return next;
  };
  let text = input;
  text = step("newline", text, text.replace(/\r\n?/gu, "\n"));
  text = step("trim", text, text.trim());
  text = step("repeat_spaces", text, text.replace(/[ \t\u3000]{2,}/gu, " "));
  return { text: text.trim(), edits };
}

// 表記の揺れを消して比べるための鍵。表示に使う文字列は変えない。
export function comparisonKey(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\s\u200B-\u200D\uFEFF]/gu, "");
}

// 文字も数字も残らない発話（フィラーだけ・空白だけ）。新しい検索や回答生成を始めない。
export function hasNoQuestionText(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(text);
}
