import type { Evidence, LengthBudget, SourceVersion } from "../types.ts";
import type { KnowledgeRepository } from "../knowledge/repository.ts";
import { sha256 } from "../knowledge/text.ts";
import { measureText, lengthPolicy } from "./length-policy.ts";

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
    || value.version !== 1 || value.reviewedBy !== "ai" || !nonempty(value.text)
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
// 現行予算を超えるキャッシュはnullを返し、通常生成へフォールバックさせる。
// 予算未指定時は自己紹介の標準方針を上限として扱い、既存176文字キャッシュを維持する。
export async function loadCareerOverview(raw: string | undefined, repository: KnowledgeRepository, budget?: LengthBudget): Promise<{ text: string; evidence: Evidence[]; sourceSet: SourceVersion[] } | null> {
  const overview = parseOverview(raw);
  if (!overview) return null;
  const max = budget && Number.isFinite(budget.max) && budget.max > 0 ? budget.max : lengthPolicy("自己紹介").max;
  if (measureText(overview.text) > max) return null;
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

// 音声では前の語の切れ端(と・では等)が頭に付くことがある。全体の形が一致するときだけ概要として扱う。
const overviewLead = "(?:(?:あの|あ|えっと|ええと|えーと|と|では|じゃあ|それでは)[ー〜~]*|まずは?|最初に|簡単に|手短に){0,3}";
const overviewAdjective = "(?:簡単な|手短な)";
const overviewPossessive = `(?:あなたの${overviewAdjective}?|${overviewAdjective}(?:あなたの)?)?`;
const overviewTarget = "(?:自己紹介|経歴紹介|(?:(?:これまで|今まで)の)?(?:ご?経歴(?:の?概要)?|ご?略歴|歩み|道のり)|(?:これまで|今まで)の仕事)";
const politeEnding = "(?:ください|(?:いただけ|もらえ)ますか)";
const overviewRequest = `(?:お願い(?:します|いたします|できますか|してもいいですか)|(?:説明して|教えて|聞かせて|して)${politeEnding}|教えて)`;
const overviewParticle = "(?:を|から|について|に関して)?";
const overviewIntent = new RegExp(`^${overviewLead}${overviewPossessive}${overviewTarget}${overviewParticle}${overviewLead}${overviewRequest}$`, "u");
// 「職歴はどんな感じ？」のように、全体像を短く尋ねる聞き方も概要の依頼として扱う。
const overviewCasualTarget = "(?:職歴|ご?経歴|会社員経験|これまでの仕事|自己紹介)";
const overviewCasual = new RegExp(`^${overviewLead}(?:あなたの)?${overviewCasualTarget}(?:は|って|の)?(?:どんな感じ|どんなもの|全体像|概要)(?:ですか|でしょうか)?[?？]?$`, "u");
// 「これまでどんな仕事をしてきましたか」のように、対象の前に「どんな」が入る聞き方も概要の依頼として扱う。
const overviewWhatWork = new RegExp(`^${overviewLead}(?:あなたの)?(?:これまで|今まで)?どんな(?:仕事|職歴|経歴|活動)(?:を)?(?:されてきました|してきました|してきた|されてきた|をしてきました)?(?:でした|なん)?(?:か|ですか|でしょうか|んですか|のですか)?[?？]?$`, "u");

export function asksForCareerOverview(question: string): boolean {
  // 回答は日本語が原則のため、言語の指定は依頼の形から外して同じ概要を返す。
  // 音声認識は語を空白で区切るため、言い淀みや聞き違いの語を1トークンとして外す。
  // 単独の「あ」「え」を語頭から食わないよう、トークン全体が一致するときだけ外す。
  // 「ご経歴」が「こう経歴」と聞き取られる例があるため、語中に入ったノイズも除く。
  const noise = /^(?:あ|あー+|え|えー+|あの|あのー|えっと|ええと|えーと|うーん|うん|はい|その|なんか|まあ|こう|そう)$/u;
  const tokens = question.normalize("NFKC").split(/\s+/u).filter(Boolean).filter(token => !noise.test(token));
  if (!tokens.length) return false;
  const text = tokens.join("").replace(/[、。,.!?]+/gu, "")
    .replace(/(?:英語|英文|えいご|イングリッシュ|english|中国語|韓国語|フランス語|スペイン語|ドイツ語)(?:で|に)?/giu, "");
  return overviewIntent.test(text) || overviewCasual.test(text) || overviewWhatWork.test(text);
}
