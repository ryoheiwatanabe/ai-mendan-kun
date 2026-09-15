import { visibleEvidenceContent } from "../knowledge/evidence-text.ts";
import type { Claim, Evidence, ModelPayload, Segment, SegmentKind } from "../types.ts";
import { normalize, approvedUnits, approvedNames } from "../knowledge/text.ts";
import { asksForName } from "./conversation.ts";

export function highRisk(text: string, entities: string[] = []): boolean {
  return /[0-9０-９一二三四五六七八九十百千万億兆]+\s*(人|名|件|本|円|年|月|日|%|％|倍|万|億)|\d|売上|年収|給与|学歴|卒業|資格|創業|設立|入社|退社|退職|実装|企画|設計|担当|責任|役割|肩書|役職|社長|代表|PM|PdM|CEO|CTO|全部|すべて|契約|承諾|参加意思/i.test(text)
    || entities.some(entity => normalize(text).toLowerCase().includes(normalize(entity).toLowerCase()));
}

export type SegmentCheck =
  | { ok: true; text: string; matchedEvidenceIds: string[]; synthesized: boolean }
  | { ok: false; reason: string };

const dynamicKinds: SegmentKind[] = ["grounded_synthesis", "interpretation"];
// 回答の種類。Providerごとの対応表を作らず、この1か所を正本にする。
export const segmentKinds: SegmentKind[] = ["fact", "name", "grounded_synthesis", "interpretation", "conversational"];
const allKinds: SegmentKind[] = segmentKinds;

// 根拠が要らない会話応答の上限。挨拶や受け止めの一言に収める。
export const conversationalLimit = 120;

// 質問・依頼・相談の形。この形の入力では、根拠のない会話応答を返さない。
// 挨拶や相槌はこの形に当たらないため、LLMの柔軟な応答路を通せる。
const questionShape = /[?？]|(?:でしょうか|ますでしょうか|ますか|ですか|ましたか|ませんか|ありますか|いますか|できますか|可能ですか|経験は|ください|下さい|教えて|聞かせて|伺いたい|知りたい|どんな|どの|どちら|どう(?!も)|なに|何|いつ(?!も)|どこ|だれ|誰|なぜ|なんで|どのくらい|いくら|いくつ|できます|可能で|たいです)/u;

export function looksLikeQuestion(message: string): boolean {
  return questionShape.test(message);
}

// 表示する空でない文を返す。句点区切りと改行。
export function displayedSentences(text: string): string[] {
  return normalize(text).split(/(?<=[。！？!?])\s*|\n+/u)
    .map(value => value.trim()).filter(Boolean);
}

// NFKC正規化した上で、数値トークンを桁区切りカンマを含めて抽出する。
// 数値はNFKCで半角化し、単独の桁区切りを許容して実値を得る。単位・年はそのまま保持する。
type NumericToken = { value: string; unit: string };

function numericTokens(text: string): NumericToken[] {
  const normalized = normalize(text);
  const tokens: NumericToken[] = [];
  const matcher = /[0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?(?:\s*(?:%|％|円|万円|億円|人|名|件|本|年|月|日|歳|時間|回|社|店|個|点|倍))?/g;
  for (const match of normalized.matchAll(matcher)) {
    const raw = match[0];
    const unitMatch = raw.match(/^(?:([0-9]+)(?:,([0-9]{3}))*(?:\.[0-9]+)?)\s*(.*)$/);
    if (!unitMatch) continue;
    const valuePart = raw.slice(0, raw.length - (unitMatch[3] ? unitMatch[3].length : 0)).replace(/,/g, "");
    const unit = unitMatch[3] ? unitMatch[3].trim() : "";
    tokens.push({ value: valuePart, unit });
  }
  return tokens;
}

// claimの数値は、同じ値の引用があれば足りる。引用が単位を伴う場合はclaimの単位と一致を求めるが、
// claim側が単位を省くのは許す。原文の「週5日勤務」を回答で「週5勤務」と書いただけで
// 意味を変えていない回答が落ちるため。claim側が単位を付け足す場合は、引用にない単位になるので認めない。
function numberSupported(claim: NumericToken, quoted: NumericToken[]): boolean {
  return quoted.some(token => token.value === claim.value && (claim.unit === "" || claim.unit === token.unit));
}

function quoteSupported(quote: string, sources: Evidence[]): boolean {
  const needle = normalize(quote);
  if (!needle) return false;
  return sources.some(source => normalize(visibleEvidenceContent(source)).includes(needle));
}

// 不足説明の自然な語形を受け、数値等の混入を機械確認する。
// 事実の肯定・否定を紛れ込ませていないかは、続く回答全体の校閲で確認する。
const limitationPattern = /(確認が必要|未確定|未定|(?:確認|判断)でき(?:ていない|ていません|ない|ません)|(?:記録|情報)(?:が|は)(?:ない|ありません|見つからない|見つかりません|確認でき(?:ない|ません|ていない|ていません)|不足)|不明|未確認|分からない|わからない|分かりません|わかりません|(?:まだ)?決まってい(?:ない|ません)|本人(?:が|の)(?:判断|決定|決める))/;
// 確認の依頼は、不足を述べたうえで本人へ尋ねる文だけを認める。事実の断定を混ぜた文は通さない。
const confirmationRequestPattern = /^[^。]{0,24}(?:面談|本人)(?:で|に)?[^。]{0,12}(?:確認|聞|尋ね)[^。]{0,6}ください[。]?$/;
const positiveFactPattern = /[0-9０-９]+|株式会社|代表|社長|CEO|CTO|氏名|さん$/;

function isLimitationText(text: string): boolean {
  const normalized = normalize(text);
  if (!limitationPattern.test(normalized) && !confirmationRequestPattern.test(normalized)) return false;
  if (positiveFactPattern.test(normalized)) return false;
  return true;
}

// claimsを機械検証する。references / quote部分文字列 / 主張カバレッジ / 数値トークンを主張ごとに確認する。
// 主張カバレッジはclaim.textの順序付き完全結合が実際のsegment.textと一致することを要求する。
// 1 claimのtextは1-2文にまたがってよい。文単位一致よりも結合一致で判定する。
// 意味の支持・全体整合はここでは証明しない。それは別途、回答単位の校閲が担う。
export function validateClaims(segment: { text: string; claims: Claim[]; evidenceIds: string[] }, evidence: Evidence[]):
  { ok: true; matchedEvidenceIds: string[] } | { ok: false; reason: string } {
  if (!Array.isArray(segment.claims) || !segment.claims.length) return { ok: false, reason: "missing_claims" };
  if (segment.claims.length > 8) return { ok: false, reason: "too_many_claims" };
  const sentences = displayedSentences(segment.text);
  if (!sentences.length) return { ok: false, reason: "empty_text" };
  const matched = new Set<string>();
  const coveredTexts: string[] = [];
  let backedClaims = 0;
  let limitationClaims = 0;
  for (const claim of segment.claims) {
    if (!claim || typeof claim.text !== "string" || !claim.text.trim() || Array.from(claim.text).length > 1200) return { ok: false, reason: "invalid_claim" };
    coveredTexts.push(claim.text);
    if (!Array.isArray(claim.supports) || claim.supports.length > 4) return { ok: false, reason: "invalid_supports" };
    const limitation = claim.kind === "limitation";
    if (limitation && claim.supports.length) return { ok: false, reason: "invalid_limitation" };
    if (limitation) {
      if (!isLimitationText(claim.text)) return { ok: false, reason: "invalid_limitation" };
      limitationClaims += 1;
    } else {
      if (!claim.supports.length) return { ok: false, reason: "missing_supports" };
    }
    const claimNumbers = numericTokens(claim.text);
    const quotedNumbers: NumericToken[] = [];
    for (const support of claim.supports) {
      if (!support || typeof support.evidenceId !== "string" || typeof support.quote !== "string" || Array.from(support.quote).length > 800) return { ok: false, reason: "invalid_support" };
      if (!segment.evidenceIds.includes(support.evidenceId)) return { ok: false, reason: "support_not_declared" };
      const source = evidence.find(item => item.id === support.evidenceId);
      if (!source) return { ok: false, reason: "unknown_evidence" };
      if (!quoteSupported(support.quote, [source])) return { ok: false, reason: "quote_not_found" };
      quotedNumbers.push(...numericTokens(support.quote));
      matched.add(source.id);
    }
    for (const token of claimNumbers) if (!numberSupported(token, quotedNumbers)) return { ok: false, reason: "claim_number_unsupported" };
    if (!limitation) backedClaims += 1;
  }
  if (!backedClaims) return { ok: false, reason: "no_backed_claim" };
  const joined = coveredTexts.join("");
  if (joined !== segment.text) return { ok: false, reason: "claim_coverage" };
  return { ok: true, matchedEvidenceIds: [...matched] };
}

export function validateSegment(segment: Segment, evidence: Evidence[], allowInterpretation = false, question = ""): SegmentCheck {
  if (!segment || typeof segment.text !== "string" || !segment.text.trim() || Array.from(segment.text).length > 1200
    || !allKinds.includes(segment.kind) || !Array.isArray(segment.evidenceIds)) return { ok: false, reason: "invalid_segment" };
  const declared = segment.evidenceIds;
  // 根拠を要さない会話応答。質問形の入力や、本人の事実・数値・固有名詞を含む文は認めない。
  if (segment.kind === "conversational") {
    if (declared.length) return { ok: false, reason: "conversation_evidence" };
    if (looksLikeQuestion(question)) return { ok: false, reason: "conversation_not_allowed" };
    if (Array.from(segment.text).length > conversationalLimit) return { ok: false, reason: "invalid_segment" };
    const text = normalize(segment.text);
    if (numericTokens(text).length || highRisk(text, evidence.flatMap(item => item.entities))) return { ok: false, reason: "conversational_claim" };
    if (evidence.some(item => approvedNames(item).some(name => text.includes(normalize(name))))) return { ok: false, reason: "conversational_claim" };
    return { ok: true, text: segment.text, matchedEvidenceIds: [], synthesized: true };
  }
  if (!declared.length || declared.length > 6 || declared.some(id => typeof id !== "string")) return { ok: false, reason: "invalid_segment" };
  const sources = declared.map(id => evidence.find(item => item.id === id));
  if (sources.some(item => !item)) return { ok: false, reason: "unknown_evidence" };
  const approved = sources as Evidence[];
  const text = normalize(segment.text);

  if (segment.kind === "name") {
    const matched = approved.filter(item => approvedNames(item).includes(text));
    if (!asksForName(question) || !matched.length) return { ok: false, reason: "unsupported_name" };
    return { ok: true, text: `${text}です。`, matchedEvidenceIds: matched.map(item => item.id), synthesized: false };
  }

  if (segment.kind === "fact") {
    const units = text.split(/\n\s*\n/).map(unit => unit.trim()).filter(Boolean);
    if (!units.length || units.some(unit => !approved.some(item => approvedUnits(visibleEvidenceContent(item)).includes(unit)))) return { ok: false, reason: "unsupported_fact" };
    if (text.length > 1200) return { ok: false, reason: "invalid_segment" };
    return { ok: true, text, matchedEvidenceIds: approved.filter(item => units.some(unit => approvedUnits(visibleEvidenceContent(item)).includes(unit))).map(item => item.id), synthesized: false };
  }

  if (!dynamicKinds.includes(segment.kind)) return { ok: false, reason: "invalid_kind" };
  if (segment.kind === "interpretation" && !allowInterpretation) return { ok: false, reason: "interpretation_not_requested" };

  const claims = "claims" in segment ? segment.claims : [];
  const checked = validateClaims({ text: segment.text, claims, evidenceIds: declared }, evidence);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  return { ok: true, text: segment.text, matchedEvidenceIds: checked.matchedEvidenceIds, synthesized: true };
}

function parseClaim(value: unknown): Claim {
  if (!value || typeof value !== "object") throw new Error("invalid_model_claim");
  const item = value as Record<string, unknown>;
  if (typeof item.text !== "string" || Array.from(item.text).length > 1200 || !Array.isArray(item.supports) || item.supports.length > 4) throw new Error("invalid_model_claim");
  const supports = item.supports.map(raw => {
    if (!raw || typeof raw !== "object") throw new Error("invalid_model_claim");
    const support = raw as Record<string, unknown>;
    if (typeof support.evidenceId !== "string" || typeof support.quote !== "string" || Array.from(support.quote).length > 800) throw new Error("invalid_model_claim");
    return { evidenceId: support.evidenceId, quote: support.quote };
  });
  if (item.kind === undefined || item.kind === null) return { text: item.text, supports };
  if (item.kind !== "limitation" && item.kind !== "statement") throw new Error("invalid_model_claim");
  return { text: item.text, supports, kind: item.kind };
}

// 推論されたlimitationはsupports空のみ。textがmissing-info説明に一致する場合だけkindを補う。
function inferClaimKind(claim: Claim): Claim {
  if (claim.kind) return claim;
  if (!claim.supports.length && isLimitationText(claim.text)) return { text: claim.text, supports: [], kind: "limitation" };
  return claim;
}

export function parseSegment(value: unknown): Segment {
  if (!value || typeof value !== "object") throw new Error("invalid_model_segment");
  const item = value as Record<string, unknown>;
  const kinds: SegmentKind[] = segmentKinds;
  if (typeof item.kind !== "string" || !kinds.includes(item.kind as SegmentKind) || typeof item.text !== "string"
    || Array.from(item.text).length > 1200 || !Array.isArray(item.evidenceIds) || item.evidenceIds.length > 6
    || item.evidenceIds.some(id => typeof id !== "string")) throw new Error("invalid_model_segment");
  const evidenceIds = item.evidenceIds as string[];
  const kind = item.kind as SegmentKind;
  if (dynamicKinds.includes(kind)) {
    if (!Array.isArray(item.claims) || item.claims.length > 8) throw new Error("invalid_model_claim");
    return { kind, text: item.text, evidenceIds, claims: item.claims.map(parseClaim).map(inferClaimKind) } as Segment;
  }
  return { kind, text: item.text, evidenceIds } as Segment;
}

function canonicalSegment(segment: Segment) {
  if (segment.kind === "fact" || segment.kind === "name" || segment.kind === "conversational") return { kind: segment.kind, text: segment.text, evidenceIds: [...segment.evidenceIds] };
  return { kind: segment.kind, text: segment.text, evidenceIds: [...segment.evidenceIds],
    claims: segment.claims.map(claim => ({ text: claim.text, kind: claim.kind, supports: claim.supports.map(support => ({ evidenceId: support.evidenceId, quote: support.quote })) })) };
}

export function sameCandidate(a: ModelPayload, b: ModelPayload): boolean {
  return JSON.stringify({ segments: a.segments.map(canonicalSegment), answerability: a.answerability, confidence: a.confidence })
    === JSON.stringify({ segments: b.segments.map(canonicalSegment), answerability: b.answerability, confidence: b.confidence });
}

export function parsePayload(value: unknown): ModelPayload {
  if (!value || typeof value !== "object") throw new Error("invalid_model_payload");
  const item = value as Record<string, unknown>;
  if (!Array.isArray(item.segments) || item.segments.length > 4) throw new Error("invalid_model_payload");
  const answerabilities = ["answerable", "partial", "unknown", "ambiguous"];
  const confidences = ["high", "medium", "low"];
  if (typeof item.answerability !== "string" || !answerabilities.includes(item.answerability)
    || typeof item.confidence !== "string" || !confidences.includes(item.confidence as string)) throw new Error("invalid_model_payload");
  return { segments: item.segments.map(parseSegment), answerability: item.answerability as ModelPayload["answerability"], confidence: item.confidence as ModelPayload["confidence"] };
}
