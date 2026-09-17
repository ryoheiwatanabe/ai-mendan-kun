// 4-1: 根拠の受け渡しを1つの形式へそろえ、送信直前に公開状態を確認する。
// Aの人手選択・Bの検索結果・Cの固定根拠を同じ形で扱い、実際にモデルへ渡る本文まで追う。
import type { Evidence } from "../../../lib/types.ts";
import type { KnowledgeRepository } from "../../../lib/knowledge/repository.ts";

export type HandoffKind = "chunk" | "fact";

export interface HandoffItem {
  id: string;
  kind: HandoffKind;
  title: string;
  text: string;
  revisionId: string;
  documentId: string;
  contentHash: string;
  order: number;
}

// Evidence（チャンクとExact Factの両方）を、共通の根拠形式へ写す。
export function toHandoff(evidence: Evidence[]): HandoffItem[] {
  return evidence.map((item, index) => ({
    id: item.id,
    kind: item.kind === "exact_fact" ? "fact" : "chunk",
    title: item.title,
    text: item.content,
    revisionId: item.revisionId,
    documentId: item.documentId,
    contentHash: item.contentHash,
    order: index
  }));
}

// 固定根拠を、アプリのエンジンへ渡せるEvidenceの形へ戻す（Factも落とさない）。
export function toEvidence(items: HandoffItem[]): Evidence[] {
  return items.map((item, index) => ({
    id: item.id,
    kind: item.kind === "fact" ? "exact_fact" : "chunk",
    revisionId: item.revisionId,
    documentId: item.documentId,
    contentHash: item.contentHash,
    title: item.title,
    content: item.text,
    entities: [],
    rank: index
  }));
}

// モデルへ渡す本文（A/Bの短い指示で使うJSON）。idと本文を同じ形で並べる。
export function handoffBody(input: { question: string; history: { role: string; content: string }[]; items: HandoffItem[] }): string {
  return JSON.stringify({
    question: input.question,
    history: input.history,
    evidence: input.items.map(item => ({ id: item.id, kind: item.kind, title: item.title, text: item.text }))
  });
}

export function handoffSummary(items: HandoffItem[]): { ids: string[]; kinds: HandoffKind[]; textHashes: string[]; order: number[] } {
  return {
    ids: items.map(item => item.id),
    kinds: items.map(item => item.kind),
    textHashes: items.map(item => shortHash(item.text)),
    order: items.map(item => item.order)
  };
}

// 送信直前の確認。いまの公開・承認・現行版で読み直せない根拠は送らない。
export function factRevisionId(id: string): string | null {
  const parts = id.split(":");
  return parts.length >= 3 && parts[0] === "fact" ? parts[1] : null;
}

// 送信直前の確認。チャンクはresolveで、Factは現行版の集合で読み直す。
// resolveはチャンクだけを返すため、Factをそのまま渡すと落ちてしまう（この不具合の修正）。
export async function assertPublicNow(
  repository: KnowledgeRepository,
  items: HandoffItem[]
): Promise<{ kept: HandoffItem[]; dropped: { id: string; reason: string }[] }> {
  if (!items.length) return { kept: [], dropped: [] };
  const chunkIds = items.filter(item => item.kind === "chunk").map(item => item.id);
  const current = chunkIds.length ? await repository.resolve(chunkIds) : [];
  const alive = new Set(current.map(item => item.id));
  const needsFacts = items.some(item => item.kind === "fact");
  const revisions = new Set(needsFacts ? (await repository.sourceSet()).map(version => version.revisionId) : []);
  const kept: HandoffItem[] = [];
  const dropped: { id: string; reason: string }[] = [];
  for (const item of items) {
    if (item.kind === "fact") {
      const revisionId = factRevisionId(item.id);
      if (revisionId && revisions.has(revisionId)) kept.push(item);
      else dropped.push({ id: item.id, reason: "fact_revision_not_current" });
      continue;
    }
    if (alive.has(item.id)) kept.push(item);
    else dropped.push({ id: item.id, reason: "not_current_or_not_public" });
  }
  return { kept, dropped };
}

// 実際にモデルへ渡る本文（プロバイダの入力）から、根拠のIDと本文を検査する。
export function inspectModelInput(evidence: Evidence[], expected: HandoffItem[]): {
  sentIds: string[];
  missingInPrompt: string[];
  textMismatch: string[];
  extraIds: string[];
} {
  const sent = new Map(toHandoff(evidence).map(item => [item.id, item.text]));
  const expectedIds = new Set(expected.map(item => item.id));
  return {
    sentIds: [...sent.keys()],
    missingInPrompt: expected.filter(item => !sent.has(item.id)).map(item => item.id),
    textMismatch: expected.filter(item => sent.has(item.id) && sent.get(item.id) !== item.text).map(item => item.id),
    extraIds: [...sent.keys()].filter(id => !expectedIds.has(id))
  };
}

// 渡す本文の中に、指定の文字列が実際に含まれるか（M01/M10のFact確認などに使う）。
export function missingTexts(items: HandoffItem[], needles: string[]): string[] {
  const body = items.map(item => item.text).join(String.fromCharCode(10));
  return needles.filter(needle => !body.includes(needle));
}

function shortHash(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
