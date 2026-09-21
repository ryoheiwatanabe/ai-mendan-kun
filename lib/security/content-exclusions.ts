import { PublicError } from "./request.ts";

// 値はWorkers Secretからだけ読み、ブラウザーへ返さない。公開の例やテストでは架空値を使う。
export type ContentExclusionPolicy = {
  readonly revision: string;
  matches(text: string): boolean;
  matchedRuleIds(text: string): string[];
  mask(text: string): string;
};

export const excludedContentReply = "この話題にはお答えしていません。別の経験や仕事についてお聞きください。";
export const excludedContentMask = "［非表示の内容］";
const spaces = /[\s\u200B-\u200D\uFEFF]/gu;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function getContentExclusions(env: { USER_CONTENT_EXCLUSIONS?: string }): ContentExclusionPolicy {
  const raw = env.USER_CONTENT_EXCLUSIONS;
  try {
    // 設定漏れで非表示指定を解除しない。規則なしを意図する環境も、空のrulesを明示する。
    if (raw === undefined || raw === "") throw new Error();
    if (raw.length > 32_000) throw new Error();
    const value = JSON.parse(raw) as { version?: unknown; rules?: unknown };
    if (!Number.isInteger(value.version) || Number(value.version) < 1 || !Array.isArray(value.rules) || value.rules.length > 64) throw new Error();
    const ids = new Set<string>();
    const rules = value.rules.map((item: unknown) => {
      const rule = item as { id?: unknown; literal?: unknown } | null;
      if (!rule || typeof rule.id !== "string" || !/^[a-z0-9_]{1,80}$/.test(rule.id) || ids.has(rule.id)
        || typeof rule.literal !== "string" || !rule.literal.trim() || rule.literal.length > 200) throw new Error();
      ids.add(rule.id);
      const literal = rule.literal.normalize("NFKC").toLowerCase().replace(spaces, "");
      if (!literal) throw new Error();
      // 字間の空白は許すが、短い英略語を別の単語の途中から拾わない。
      // 短い日本語の指定も単語内の一致で無関係な語を壊さない。
      const chars = [...literal];
      const left = /^[a-z0-9]/u.test(literal) ? "(?<![a-z0-9])" : chars.length <= 2 ? "(?<![\\p{L}\\p{N}])" : "";
      const right = /[a-z0-9]$/u.test(literal) ? "(?![a-z0-9])" : chars.length <= 2 ? "(?![\\p{L}\\p{N}])" : "";
      const expression = new RegExp(left + chars.map(escape).join("[\\s\\u200B-\\u200D\\uFEFF]*") + right, "u");
      return { id: rule.id, expression };
    });
    // 内容を公開しない設定版。規則の変更をキャッシュの識別へ含めるためだけに使う。
    let fingerprint = 2166136261;
    for (const char of raw) fingerprint = Math.imul(fingerprint ^ char.charCodeAt(0), 16777619);
    const matchedRuleIds = (text: string) => {
      const normalized = text.normalize("NFKC").toLowerCase();
      return rules.filter(rule => rule.expression.test(normalized)).map(rule => rule.id);
    };
    return Object.freeze({ revision: `${value.version}-${(fingerprint >>> 0).toString(16)}`,
      matchedRuleIds, matches: (text: string) => matchedRuleIds(text).length > 0,
      // 名前だけを消して元の文の意味を変えない。該当発話は全体を非表示にする。
      mask: (text: string) => matchedRuleIds(text).length ? excludedContentMask : text });
  } catch {
    throw new PublicError("EXCLUSION_NOT_CONFIGURED", 503, "公開情報の設定を確認しています。時間をおいてお試しください。");
  }
}

export const emptyContentExclusions: ContentExclusionPolicy = Object.freeze({
  revision: "none", matches: (_text: string) => false, matchedRuleIds: (_text: string) => [], mask: (text: string) => text
});

export function containsExcludedContent(value: unknown, policy: ContentExclusionPolicy): boolean {
  if (typeof value === "string") {
    if (policy.matches(value)) return true;
    // DBのJSON列にUnicodeエスケープされたaliasも同じ規則で確認する。
    if (/^\s*[\[{]/u.test(value)) {
      try { return containsExcludedContent(JSON.parse(value), policy); } catch { /* 通常の文章 */ }
    }
    return false;
  }
  if (Array.isArray(value)) return value.some(item => containsExcludedContent(item, policy));
  if (value && typeof value === "object") return Object.values(value).some(item => containsExcludedContent(item, policy));
  return false;
}

export function assertAllowedContent(value: unknown, policy: ContentExclusionPolicy): void {
  if (containsExcludedContent(value, policy)) throw new PublicError("CONTENT_EXCLUDED", 422, "非表示に指定された内容が含まれています。公開対象を見直してください。");
}
