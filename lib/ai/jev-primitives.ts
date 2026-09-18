// TypeSafe Jevの3つの判定プリミティブ。用途を分けて使い、最終的な合成はコード側で行う。
// - Noul: はい/いいえの確率（confidenceは返らない）
// - Choice: 選択肢とその確率、confidence（分布の確かさ）
// - Score: 段階評価（レベル数までの小数）とconfidence
// 参考: docs.typesafe.ai（Introduction / primitives/choice / primitives/score / primitives/noul）
export type NoulQuestion = { type: "noul"; instructions: string };
export type ChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> };
export type ScoreQuestion = { type: "score"; instructions: string; criteria: string[] };
export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type ParsedAnswer =
  | { type: "noul"; value: number }
  | { type: "choice"; choice: string; probabilities?: Record<string, number>; confidence?: number }
  | { type: "score"; score: number; confidence?: number; levels: number };
export type ParsedAnswers = { answers: Record<string, ParsedAnswer>; usage?: { input: number; output: number } };

function numberIn(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

// 返ってきた答えを質問の型に照らして検査する。形が違う応答は既定値で埋めずに拒否する。
export function parseJevAnswers(value: unknown, questions: Record<string, JevQuestion>): ParsedAnswers {
  const body = value as { answers?: Record<string, unknown>; usage?: { input_tokens?: unknown; output_tokens?: unknown } } | null;
  if (!body || !body.answers || typeof body.answers !== "object") throw new Error("invalid_jev_response");
  const answers: Record<string, ParsedAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = body.answers[id] as Record<string, unknown> | undefined;
    if (!answer || typeof answer !== "object" || answer.type !== question.type) throw new Error("invalid_jev_response");
    if (question.type === "noul") {
      // 旧形式のprobabilityも受け付ける。
      const raw = "noul" in answer ? answer.noul : answer.probability;
      const score = numberIn(raw, 0, 1);
      if (score === null) throw new Error("invalid_jev_response");
      answers[id] = { type: "noul", value: score };
      continue;
    }
    if (question.type === "choice") {
      if (typeof answer.choice !== "string" || !(answer.choice in question.criteria)) throw new Error("invalid_jev_response");
      const confidence = answer.confidence === undefined ? undefined : numberIn(answer.confidence, 0, 1);
      if (answer.confidence !== undefined && confidence === null) throw new Error("invalid_jev_response");
      let probabilities: Record<string, number> | undefined;
      if (answer.probabilities !== undefined) {
        if (typeof answer.probabilities !== "object" || Array.isArray(answer.probabilities)) throw new Error("invalid_jev_response");
        probabilities = {};
        for (const [option, weight] of Object.entries(answer.probabilities as Record<string, unknown>)) {
          const parsed = numberIn(weight, 0, 1);
          if (parsed === null) throw new Error("invalid_jev_response");
          probabilities[option] = parsed;
        }
      }
      answers[id] = { type: "choice", choice: answer.choice, ...(probabilities ? { probabilities } : {}), ...(confidence === null || confidence === undefined ? {} : { confidence }) };
      continue;
    }
    const levels = question.criteria.length;
    const score = numberIn(answer.score, 0, levels - 1);
    if (score === null) throw new Error("invalid_jev_response");
    const confidence = answer.confidence === undefined ? undefined : numberIn(answer.confidence, 0, 1);
    if (answer.confidence !== undefined && confidence === null) throw new Error("invalid_jev_response");
    answers[id] = { type: "score", score, levels, ...(confidence === null || confidence === undefined ? {} : { confidence }) };
  }
  const input = body.usage?.input_tokens, output = body.usage?.output_tokens;
  const usage = typeof input === "number" && typeof output === "number" && Number.isFinite(input) && input >= 0 && Number.isFinite(output) && output >= 0
    ? { input, output } : undefined;
  return { answers, usage };
}

// 段階評価を0〜1へ写す。レベルの数が1つだけのときは0を返す。
export function normalizeScore(answer: Extract<ParsedAnswer, { type: "score" }>): number {
  return answer.levels > 1 ? answer.score / (answer.levels - 1) : 0;
}
