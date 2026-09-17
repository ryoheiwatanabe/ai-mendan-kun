// データの読み込み・根拠の絞り込み・生成入力の組み立て。すべて純粋な処理（通信しない）。
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ExcludedUnit, EvidenceUnit, FictionalProfile, LabCase, Turn } from "./types.mts";

const dataDir = new URL("../data/", import.meta.url);

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, dataDir), "utf8")) as T;
}

export function loadProfile(): FictionalProfile {
  return readJson<FictionalProfile>("fictional-profile.json");
}

export function loadCases(): LabCase[] {
  return readJson<{ cases: LabCase[] }>("cases.json").cases;
}

export function loadHistories(): Record<string, Turn[]> {
  return readJson<{ histories: Record<string, Turn[]> }>("histories.json").histories;
}

export function selectCases(ids: string[]): LabCase[] {
  const cases = loadCases();
  if (!ids.length) return cases;
  const wanted = new Set(ids);
  const picked = cases.filter(item => wanted.has(item.id));
  const missing = ids.filter(id => !cases.some(item => item.id === id));
  if (missing.length) throw new Error("unknown_case: " + missing.join(","));
  return picked;
}

// 承認済み・公開・対象者一致・現行版だけを使える根拠とする。使えない理由は記録に残す。
export function filterEvidence(
  profile: FictionalProfile,
  ids: string[],
  subjectId: string = profile.subjectId
): { usable: EvidenceUnit[]; excluded: ExcludedUnit[] } {
  const usable: EvidenceUnit[] = [];
  const excluded: ExcludedUnit[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const unit = profile.evidence.find(item => item.id === id);
    if (!unit) { excluded.push({ id, reason: "not_found" }); continue; }
    if (unit.approval === "revoked") { excluded.push({ id, reason: "revoked" }); continue; }
    if (unit.approval !== "approved") { excluded.push({ id, reason: "unapproved" }); continue; }
    if (unit.visibility !== "public") { excluded.push({ id, reason: "private" }); continue; }
    if (unit.subjectId && unit.subjectId !== subjectId) { excluded.push({ id, reason: "other_subject" }); continue; }
    const current = profile.sourceRevisions[unit.sourceId];
    if (current && current !== unit.sourceRevision) { excluded.push({ id, reason: "stale_revision" }); continue; }
    usable.push(unit);
  }
  return { usable, excluded };
}

// Aモードの短い指示。H1（短い指示と1回生成で自然に答えられるか）を試すための最小構成。
export const answerSystem = [
  "あなたは、与えられた承認済みの根拠だけを使って面談の質問へ答える補助者です。",
  "- 質問に直接答える。日本語で1〜3文。",
  "- 根拠に書かれていない事実・年・金額・主体・担当範囲・因果を足さない。",
  "- 根拠では答えられない部分は limitations へ短く書く。無ければ空文字。",
  "- 履歴は、質問が何を指すかを決めるためだけに使う。履歴の文を事実の根拠にしない。",
  "- 出力はJSONオブジェクト1つだけ。"
].join("\n");

export const answerSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "sourceIds", "limitations"],
  properties: {
    answer: { type: "string" },
    sourceIds: { type: "array", maxItems: 6, items: { type: "string" } },
    limitations: { type: "string" }
  }
};

export const promptVersion = createHash("sha256")
  .update(answerSystem + JSON.stringify(answerSchema))
  .digest("hex")
  .slice(0, 8);

// 生成へ渡す入力。採点用のgold（mustInclude / mustNot）は絶対に含めない。
export function buildAnswerInput(
  item: LabCase,
  history: Turn[],
  usable: EvidenceUnit[]
): { system: string; user: string } {
  return {
    system: answerSystem,
    user: JSON.stringify({
      question: item.question,
      history: history.map(turn => ({ role: turn.role, content: turn.content })),
      evidence: usable.map(unit => ({ id: unit.id, text: unit.text, ...(unit.period ? { period: unit.period } : {}) }))
    })
  };
}
