import type { Evidence, SourceVersion } from "../types.ts";
import type { KnowledgeRepository } from "../knowledge/repository.ts";
import { sha256 } from "../knowledge/text.ts";

type SourceRef = { id: string; fingerprint: string };
type Overview = { version: 1; text: string; sources: SourceRef[]; reviewedBy: "ai"; sourceSet: SourceVersion[] };
const hash = /^[a-f0-9]{64}$/u;

function record(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function nonempty(value: unknown): value is string { return typeof value === "string" && !!value.trim(); }

function parseOverview(raw: string | undefined): Overview | null {
  if (typeof raw !== "string" || raw.length > 5120 || new TextEncoder().encode(raw).length > 5120) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!record(value, ["version", "text", "sources", "reviewedBy", "sourceSet"])
    || value.version !== 1 || value.reviewedBy !== "ai" || !nonempty(value.text) || value.text.length > 350
    || !Array.isArray(value.sources) || !value.sources.length || value.sources.length > 10
    || !Array.isArray(value.sourceSet) || !value.sourceSet.length) return null;
  const sources: SourceRef[] = [], sourceSet: SourceVersion[] = [];
  for (const item of value.sources) {
    if (!record(item, ["id", "fingerprint"]) || !nonempty(item.id) || typeof item.fingerprint !== "string" || !hash.test(item.fingerprint)) return null;
    sources.push({ id: item.id, fingerprint: item.fingerprint });
  }
  for (const item of value.sourceSet) {
    if (!record(item, ["documentId", "revisionId", "contentHash"]) || !nonempty(item.documentId) || !nonempty(item.revisionId)
      || typeof item.contentHash !== "string" || !hash.test(item.contentHash)) return null;
    sourceSet.push({ documentId: item.documentId, revisionId: item.revisionId, contentHash: item.contentHash });
  }
  if (new Set(sources.map(source => source.id)).size !== sources.length
    || new Set(sourceSet.map(source => source.documentId)).size !== sourceSet.length) return null;
  return { version: 1, text: value.text, sources, reviewedBy: "ai", sourceSet };
}

// AIが事前校閲した派生キャッシュ。意味の保存を実行時に証明したり、原文を承認したりはしない。
export async function loadCareerOverview(raw: string | undefined, repository: KnowledgeRepository): Promise<{ text: string; evidence: Evidence[]; sourceSet: SourceVersion[] } | null> {
  const overview = parseOverview(raw);
  if (!overview) return null;
  const current = await repository.resolve(overview.sources.map(source => source.id));
  if (current.length !== overview.sources.length) return null;
  const evidence: Evidence[] = [];
  for (const source of overview.sources) {
    const item = current.find(candidate => candidate.id === source.id);
    if (!item || item.kind !== "chunk") return null;
    const fingerprint = await sha256(JSON.stringify([item.id, item.revisionId, item.documentId, item.title, item.content, item.contentHash]));
    if (fingerprint !== source.fingerprint) return null;
    evidence.push(item);
  }
  if (!await repository.revalidateSnapshot(evidence, overview.sourceSet)) return null;
  return { text: overview.text, evidence, sourceSet: overview.sourceSet };
}

// 既知の前置き・副詞だけを限られた位置で受ける。敬語や助詞を自由に取り除かない。
const overviewLead = "(?:(?:あの|あ|えっと|ええと|えーと)[ー〜~]*|まずは?|最初に|簡単に|手短に){0,3}";
const overviewAdjective = "(?:簡単な|手短な)";
const overviewPossessive = `(?:あなたの${overviewAdjective}?|${overviewAdjective}(?:あなたの)?)?`;
const overviewTarget = "(?:自己紹介|経歴紹介|(?:これまでの)?(?:経歴(?:の?概要)?|略歴)|これまでの仕事)";
const politeEnding = "(?:ください|(?:いただけ|もらえ)ますか)";
const overviewRequest = `(?:お願い(?:します|いたします|できますか|してもいいですか)|(?:教えて|聞かせて|して)${politeEnding}|教えて)`;
const overviewIntent = new RegExp(`^${overviewLead}${overviewPossessive}${overviewTarget}を?${overviewLead}${overviewRequest}$`, "u");

// 全体概要の依頼を完全消費する。対象・時期の限定や後続の質問は通常の回答経路へ渡す。
export function asksForCareerOverview(question: string): boolean {
  const text = question.normalize("NFKC").replace(/[\s、。,.!?]+/gu, "");
  return overviewIntent.test(text);
}
