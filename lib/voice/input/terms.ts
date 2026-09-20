import type { PublicTerm } from "../../knowledge/repository.ts";
import { comparisonKey, mechanicalNormalize, type InputEdit } from "./mechanical.ts";

// 公開用語辞書。親の publicTerms() が返す、現行の公開分だけで作る（除外は適用済み）。
export type TermDictionary = { revision: string; terms: PublicTerm[] };
export const emptyTermDictionary: TermDictionary = { revision: "none", terms: [] };
// 元の質問＋最大3つの補正案。複数語の全組み合わせは作らない。
export const maxCorrectionCandidates = 3;
export type CorrectionCandidate = { id: string; text: string; edits: InputEdit[]; sources: string[] };

// 辞書の版。owner・資料版・除外設定版が変われば作り直す（親は現行の公開分だけを返す）。
export function dictionaryRevision(terms: PublicTerm[], policyRevision: string): string {
  const revisions = [...new Set(terms.map(term => term.sourceRevision))].sort().join(",");
  return `${policyRevision}|${terms.length}|${revisions}`;
}

const kanaOnly = /^[\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u;
const hasKanji = /[\p{Script=Han}]/u;
const startsAlnum = /^[a-z0-9]/iu;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
type AliasEntry = { term: PublicTerm; alias: string; kana: boolean; alnum: boolean; length: number };

// 長い別名から当てる（最長一致）。
function aliasEntries(dictionary: TermDictionary): AliasEntry[] {
  const list: AliasEntry[] = [];
  for (const term of dictionary.terms) {
    for (const raw of term.aliases) {
      const alias = raw.trim();
      if (!alias) continue;
      list.push({ term, alias, kana: kanaOnly.test(alias), alnum: startsAlnum.test(alias), length: Array.from(alias).length });
    }
  }
  return list.sort((left, right) => right.length - left.length);
}

// 同じ別名が複数の名称へ対応していないか。同じ名称（別の資料版）は曖昧とみなさない。
function uniqueFor(list: AliasEntry[], entry: AliasEntry): boolean {
  const key = comparisonKey(entry.alias);
  return list.filter(item => comparisonKey(item.alias) === key)
    .every(item => comparisonKey(item.term.canonical) === comparisonKey(entry.term.canonical));
}

// 自動で置き換えてよい別名か。漢字を含む一般語・短い略語は候補にだけ残す。
function autoApplicable(entry: AliasEntry, unique: boolean): boolean {
  if (!unique || hasKanji.test(entry.alias)) return false;
  return entry.kana ? entry.length >= 3 : entry.alnum && entry.length >= 3;
}

// 単語境界。英数字は前後の英数字を避け、かなは4文字以上なら直前のかなだけを避ける。
function patternFor(entry: AliasEntry): RegExp | null {
  if (!entry.alias) return null;
  // 文字の間に入った空白（STTが入れがち）は許す。
  const body = [...entry.alias].map(char => escape(char)).join("[\\s\\u200B-\\u200D\\uFEFF]*");
  if (entry.alnum) return new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`, "giu");
  // かなの別名は、前がかなでなく、後ろが助詞・区切り・文末のときだけ置き換える（語中を書き換えない）。
  const kana = "\\p{Script=Hiragana}\\p{Script=Katakana}ー";
  return new RegExp(`(?<![${kana}])${body}(?=$|[、。！!？?，．\\s]|[はがをにでとものへやかねよなさぞぜわ])`, "gu");
}

// 引用符の中は置き換えない。引用の外側だけを順に処理し、引用そのものはそのまま残す。
const quotedSpan = /「[^」]*」|『[^』]*』|"[^"]*"|（[^）]*）|\([^)]*\)/gu;
function replaceOutsideQuotes(text: string, pattern: RegExp, replacement: string): string {
  let output = "", last = 0;
  for (const match of text.matchAll(quotedSpan)) {
    const at = match.index ?? 0;
    output += text.slice(last, at).replace(pattern, replacement) + match[0];
    last = at + match[0].length;
  }
  return output + text.slice(last).replace(pattern, replacement);
}

// 明示された一意の別名・読みだけを、単語境界を確認して名称へ置き換える。
// 近い名前がDBにあるという理由だけでは置き換えない（それは correctionCandidates の候補に回す）。
export function applyExplicitTerms(text: string, dictionary: TermDictionary): { text: string; edits: InputEdit[] } {
  const list = aliasEntries(dictionary);
  const edits: InputEdit[] = [];
  let current = text;
  for (const entry of list) {
    if (!autoApplicable(entry, uniqueFor(list, entry))) continue;
    // すでに名称が入っている文は、別名へ戻さない。
    if (comparisonKey(current).includes(comparisonKey(entry.term.canonical))) continue;
    const pattern = patternFor(entry);
    if (!pattern) continue;
    // 引用の中だけに別名がある場合は、置き換えも記録もしない。
    const replaced = replaceOutsideQuotes(current, pattern, entry.term.canonical);
    if (replaced === current) continue;
    current = replaced;
    edits.push({ rule: "dictionary", before: entry.alias, after: entry.term.canonical });
  }
  return { text: current, edits };
}

// 補正案。実際に返ったSTT候補と、対応が一意でない別名（複数の名称候補）からだけ作る。
export function correctionCandidates(input: { base: string; alternatives?: string[]; dictionary: TermDictionary }): CorrectionCandidate[] {
  const candidates: CorrectionCandidate[] = [];
  const seen = new Set([comparisonKey(input.base)]);
  const add = (id: string, text: string, edits: InputEdit[], sources: string[]) => {
    if (candidates.length >= maxCorrectionCandidates || !text.trim() || seen.has(comparisonKey(text))) return;
    seen.add(comparisonKey(text));
    candidates.push({ id, text, edits, sources });
  };
  // 1件しか返らない認識でも正常。返った候補だけを使い、全組み合わせは作らない。
  for (const [index, alternative] of (input.alternatives ?? []).entries()) {
    const normalized = mechanicalNormalize(alternative).text;
    // 基底が候補を丸ごと含む（末尾の途中結果が足されただけ）場合は、短い方を作り直さない。
    if (!normalized || comparisonKey(input.base).includes(comparisonKey(normalized))) continue;
    add(`stt_${index + 1}`, normalized, [{ rule: "stt_alternative", before: input.base, after: normalized }], ["stt"]);
  }
  // 同じ別名が複数の名称へ対応する場合は、勝手に決めず、両方を候補として残す。
  const list = aliasEntries(input.dictionary);
  for (const entry of list) {
    if (autoApplicable(entry, uniqueFor(list, entry))) continue;
    const pattern = patternFor(entry);
    if (!pattern) continue;
    const replaced = replaceOutsideQuotes(input.base, pattern, entry.term.canonical);
    if (replaced === input.base) continue;
    const matches = list.filter(item => comparisonKey(item.alias) === comparisonKey(entry.alias)
      && comparisonKey(item.term.canonical) !== comparisonKey(entry.term.canonical));
    for (const other of matches) {
      const candidate = replaceOutsideQuotes(input.base, pattern, other.term.canonical);
      if (candidate === input.base) continue;
      add(`term_${other.term.termId}`, candidate,
        [{ rule: "dictionary_candidate", before: entry.alias, after: other.term.canonical }], ["dictionary"]);
    }
  }
  return candidates;
}

// 認識器へ渡す語彙。名称と、明示された読み・別名だけを件数制限つきで返す。
// 漢字だけの別名や本文、非公開の原本は渡さない（誤認識を招く過大なブーストもしない）。
export function sttPhrases(terms: PublicTerm[], limit = 20): string[] {
  const phrases: string[] = [];
  const add = (value: string) => {
    const phrase = value.trim();
    if (phrase.length < 2 || phrase.length > 40 || phrases.includes(phrase)) return;
    phrases.push(phrase);
  };
  for (const term of terms) {
    if (phrases.length >= limit) break;
    add(term.canonical);
    for (const alias of term.aliases) if (kanaOnly.test(alias) || startsAlnum.test(alias)) add(alias);
  }
  return phrases.slice(0, limit);
}

// 否定・訂正の言い回し。消えた・増えた候補は、点数だけで採用しない。
const negationMarkers = ["ではない", "ではありません", "じゃない", "じゃなく", "ではなく", "なくはない", "とは限らない",
  "わけではない", "ません", "ない", "なく", "ず"];

// 数字・否定・公開名称は、JEVの点数だけで書き換えない。候補が元の値を保っているかを機械で確認する。
// 保てていないときは原文を維持し、短い確認へ回す（原音声を確定したことにしない）。
export function preservesCriticalTokens(base: string, candidate: string, names: string[] = []): boolean {
  const before = comparisonKey(base), after = comparisonKey(candidate);
  // 数字は値も桁区切りも保つ。
  const numbers = (text: string) => (text.match(/\d+(?:[.,]\d+)?/gu) ?? []).sort().join(",");
  if (numbers(before) !== numbers(after)) return false;
  const negations = (text: string) => negationMarkers.filter(marker => text.includes(marker)).sort().join(",");
  if (negations(before) !== negations(after)) return false;
  // 元の文にある公開名称は、候補でも同じものを保つ。
  return names.every(name => !before.includes(comparisonKey(name)) || after.includes(comparisonKey(name)));
}
