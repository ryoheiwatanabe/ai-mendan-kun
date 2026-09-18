import type { AiBinding, Evidence, Turn } from "../types.ts";
import { compactEvidence, minimalHistory } from "../answer/compact.ts";
import { jevQuestionIds, jevQuestions, jevRules, type JevAssessment, type JevInput, type JevJudge,
  type JevScopeAssessment, type JevScopeInput } from "./jev.ts";
import { jevScopeQuestions, jevScopeState, screeningQuestions, screeningState } from "./jev-scope.ts";
import { normalizeScore, parseJevAnswers, type JevQuestion } from "./jev-primitives.ts";

// Cloudflare Workers AIの typesafe/jev を、公式HTTPと同じstate/questionsで呼ぶ。
// 結果が {result: ...} に包まれる場合があるため、両方の形を受け付ける。
export class WorkersAiJev implements JevJudge {
  readonly model: string;
  private readonly ai: AiBinding;
  constructor(ai: AiBinding, model = "typesafe/jev") { this.ai = ai; this.model = model; }

  async check(input: JevInput, signal: AbortSignal): Promise<JevAssessment> {
    const requested = (input.axes?.length ? input.axes : jevQuestionIds).filter(axis => jevQuestionIds.includes(axis));
    const asked = [...new Set(requested)];
    const questions = Object.fromEntries(asked.map(axis => [axis, jevQuestions[axis]]));
    const parsed = await this.run(questions, { rules: jevRules, question: input.question,
      history: minimalHistory(input.history), evidence: compactEvidence(input.evidence), candidate: input.candidate,
      ...(input.answerScope ? { answer_scope: input.answerScope } : {}) }, signal);
    const scores = {} as Record<string, number>;
    for (const axis of asked) {
      const answer = parsed.answers[axis];
      if (!answer || answer.type !== "noul") throw new Error("invalid_jev_response");
      scores[axis] = answer.value;
    }
    return { scores, usage: parsed.usage };
  }

  async checkScope(input: JevScopeInput, signal: AbortSignal): Promise<JevScopeAssessment> {
    const { questions, asked, criteria } = jevScopeQuestions(input.evidence, input.maxJudgments);
    const parsed = await this.run(questions, jevScopeState({ question: input.question, history: input.history, evidence: input.evidence },
      input.tieBreak === true), signal);
    return { answers: parsed.answers, asked, criteria, usage: parsed.usage };
  }

  // 候補が多いときの絞り込み。候補IDごとに「役立つか」をScoreで聞く。
  async screenCandidates(input: { question: string; history: Turn[]; evidence: Evidence[]; limit: number }, signal: AbortSignal): Promise<Record<string, number>> {
    const { candidates, questions } = screeningQuestions(input.evidence, input.limit);
    const parsed = await this.run(questions, screeningState(input.question, input.history, candidates), signal);
    const scores: Record<string, number> = {};
    for (const item of candidates) {
      const answer = parsed.answers[item.id];
      if (answer?.type !== "score") throw new Error("invalid_jev_response");
      scores[item.id] = normalizeScore(answer);
    }
    return scores;
  }

  private async run(questions: Record<string, JevQuestion>, state: unknown, signal: AbortSignal): Promise<ReturnType<typeof parseJevAnswers>> {
    signal.throwIfAborted();
    const result = await this.ai.run(this.model, { questions, state });
    signal.throwIfAborted();
    const body = result && typeof result === "object" && "result" in result ? (result as { result: unknown }).result : result;
    return parseJevAnswers(body, questions);
  }
}
