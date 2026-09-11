import type { Evidence, Segment } from "../types.ts";
import { normalize, approvedUnits } from "../knowledge/text.ts";

export function highRisk(text: string, entities: string[] = []): boolean {
  return /[0-9０-９一二三四五六七八九十百千万億兆]+\s*(人|名|件|本|円|年|月|日|%|％|倍|万|億)|\d|売上|年収|給与|学歴|卒業|資格|創業|設立|入社|退社|退職|実装|企画|設計|担当|責任|役割|肩書|役職|社長|代表|PM|PdM|CEO|CTO|全部|すべて|契約|承諾|参加意思/i.test(text)
    || entities.some(entity => normalize(text).toLowerCase().includes(normalize(entity).toLowerCase()));
}

export function validateSegment(segment: Segment, evidence: Evidence[], allowInterpretation = false): { ok: boolean; text?: string; reason?: string; matchedEvidenceIds?: string[] } {
  if (!segment || typeof segment.text !== "string" || !segment.text.trim() || segment.text.length > 800
    || !Array.isArray(segment.evidenceIds) || !segment.evidenceIds.length || segment.evidenceIds.length > 6) return { ok: false, reason: "invalid_segment" };
  const sources = segment.evidenceIds.map(id => evidence.find(item => item.id === id));
  if (sources.some(item => !item)) return { ok: false, reason: "unknown_evidence" };
  const approved = sources as Evidence[];
  const text = normalize(segment.text);
  if (segment.kind === "fact") {
    // 事実の言い換えはP0では許可しない。否定・但し書きを切り落とさないよう全文単位で照合する。
    // 生成文から見出し等を除去すると、検査されなかった主張まで返してしまう。
    const units = text.split(/\n\s*\n/).map(unit => unit.trim()).filter(Boolean);
    if (!units.length || units.some(unit => !approved.some(item => approvedUnits(item.content).includes(unit)))) return { ok: false, reason: "unsupported_fact" };
    return { ok: true, text, matchedEvidenceIds: approved.filter(item => units.some(unit => approvedUnits(item.content).includes(unit))).map(item => item.id) };
  }
  if (segment.kind !== "interpretation" || !allowInterpretation) return { ok: false, reason: "invalid_kind" };
  // 機械照合で保証できない解釈を本人の言葉として流さない。数字・担当範囲等もここで禁止。
  if (highRisk(text, evidence.flatMap(item => item.entities)) || /私は|わたしは|僕は|経験して|できます|しました|しています|好きです|嫌いです|希望します|重視しています|得意です|苦手です/.test(text))
    return { ok: false, reason: "unverified_interpretation" };
  return { ok: true, text: `AIによる整理：${text}` };
}

export function parseSegment(value: unknown): Segment {
  if (!value || typeof value !== "object") throw new Error("invalid_model_segment");
  const item = value as Record<string, unknown>;
  if ((item.kind !== "fact" && item.kind !== "interpretation") || typeof item.text !== "string" || !Array.isArray(item.evidenceIds) || item.evidenceIds.some(id => typeof id !== "string")) throw new Error("invalid_model_segment");
  return { kind: item.kind, text: item.text, evidenceIds: item.evidenceIds as string[] };
}
