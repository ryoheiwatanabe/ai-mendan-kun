import { defaultJevThresholds, jevQuestionIds, jevThresholds, type JevAxis, type JevScores } from "../ai/jev.ts";
import { jevScopeAnswerScopeId, jevScopeEvidenceRoleId, jevScopeNoulIds, jevScopeNoPrimary,
  jevScopeOrder, jevScopePrimaryEvidenceId, jevScopeSupportStrengthId, type JevScopeNoulAxis } from "../ai/jev-scope.ts";
import { normalizeScore, type ParsedAnswer } from "../ai/jev-primitives.ts";
import type { Bindings } from "../types.ts";

// 各軸の扱い。required=1つでも不合格なら不採用、optional=不合格件数に数える、record=採否に使わない。
export type JevAxisTreatment = "required" | "optional" | "record";
export type JevAxisSetting = { threshold: number; treatment: JevAxisTreatment };
// 低確信（Choice/Scoreのconfidenceが閾値未満）の行き先。
export type JevLowConfidenceAction = "proceed" | "second-stage" | "partial" | "hold";
export type JevScopeSettings = {
  enabled: boolean;
  // 前段で聞く独立判定の数。段階内の上限（maxJudgmentsPerStage）と小さい方を実際に使う。
  maxQuestions: number;
  // Noulの閾値（この値以上で満たす）。
  thresholds: Record<JevScopeNoulAxis, number>;
  // Score(support_strength)を0〜1へ写した閾値。
  supportThreshold: number;
  // Choice/Scoreのconfidenceがこれ未満なら低確信として扱う。
  confidenceThreshold: number;
  lowConfidenceAction: JevLowConfidenceAction;
};
export type JevSettings = {
  axes: Record<JevAxis, JevAxisSetting>;
  // 任意軸の不合格がこの件数以上なら不採用。0は「任意軸だけでは不採用にしない」。
  optionalFailureLimit: number;
  // 直列段階・段階内の独立判定・修復回数。実装が対応する範囲を超える値は保存させない。
  limits: { maxSerialStages: number; maxJudgmentsPerStage: number; maxRepairs: number };
  // 回答全体とJEV1回の時間予算（ミリ秒）。
  budgets: { answerMs: number; jevMs: number };
  // 生成前の根拠選別（JEV①）。候補資料の関連度は、最終回答の採点とは別に持つ。
  scope: JevScopeSettings;
};

// 生成前の選別の初期閾値。答えに使えるかの軸は低めに、注意の軸は高めに置き、画面から変更できる。
export const defaultScopeThresholds: Record<JevScopeNoulAxis, number> = {
  target_match: .6, time_match: .6, direct_support: .6, background_support: .6, causal_support: .6, conflict_risk: .8
};
export const jevLowConfidenceActions: JevLowConfidenceAction[] = ["proceed", "second-stage", "partial", "hold"];

// 実装側の絶対上限。ここを超える設定は保存前に拒否し、黙って丸めない。
export const jevCeilings = {
  maxSerialStages: 3, maxJudgmentsPerStage: 10, maxRepairs: 1,
  answerMs: { min: 3000, max: 60_000 }, jevMs: { min: 500, max: 15_000 }
};
export const jevTreatments: JevAxisTreatment[] = ["required", "optional", "record"];

const axisCount = jevQuestionIds.length;

// 初期値は現行の挙動（全軸必須・全軸合格が必要）をそのまま表す。実装者が必要な軸を選び直さない。
export function defaultJevSettings(env?: Pick<Bindings, "JEV_THRESHOLDS_JSON" | "ANSWER_TIMEOUT_MS" | "JEV_TIMEOUT_MS">): JevSettings {
  const thresholds = env?.JEV_THRESHOLDS_JSON === undefined ? defaultJevThresholds : jevThresholds(env.JEV_THRESHOLDS_JSON);
  const axes = Object.fromEntries(jevQuestionIds.map(axis =>
    [axis, { threshold: thresholds[axis], treatment: "required" as const }])) as Record<JevAxis, JevAxisSetting>;
  return { axes, optionalFailureLimit: 0,
    limits: { maxSerialStages: jevCeilings.maxSerialStages, maxJudgmentsPerStage: jevCeilings.maxJudgmentsPerStage,
      maxRepairs: jevCeilings.maxRepairs },
    budgets: { answerMs: integer(env?.ANSWER_TIMEOUT_MS, 25_000, jevCeilings.answerMs), jevMs: integer(env?.JEV_TIMEOUT_MS, 4_000, jevCeilings.jevMs) },
    scope: { enabled: true, maxQuestions: jevScopeOrder.length, thresholds: { ...defaultScopeThresholds },
      supportThreshold: .6, confidenceThreshold: .5, lowConfidenceAction: "proceed" } };
}

// 環境変数の時間予算。指定があるのに範囲外なら、既定へ黙って丸めず設定エラーにする。
function integer(value: string | undefined, fallback: number, range: { min: number; max: number }): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < range.min || parsed > range.max) throw new Error("invalid_answer_timeout");
  return parsed;
}

// 保存された設定を厳密に読み直す。形・範囲・未知の項目はすべて拒否する。
export function parseJevSettings(value: unknown): JevSettings {
  const input = record(value, "invalid_jev_settings_shape");
  for (const key of Object.keys(input)) {
    if (!["axes", "optionalFailureLimit", "limits", "budgets", "scope"].includes(key)) throw new Error("invalid_jev_settings_shape");
  }
  const axesInput = record(input.axes, "invalid_jev_settings_shape");
  for (const key of Object.keys(axesInput)) if (!jevQuestionIds.includes(key as JevAxis)) throw new Error("invalid_jev_axis");
  const axes = {} as Record<JevAxis, JevAxisSetting>;
  for (const axis of jevQuestionIds) {
    const item = record(axesInput[axis], "invalid_jev_axis");
    const threshold = item.threshold;
    if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("invalid_jev_threshold");
    if (typeof item.treatment !== "string" || !jevTreatments.includes(item.treatment as JevAxisTreatment)) throw new Error("invalid_jev_treatment");
    axes[axis] = { threshold, treatment: item.treatment as JevAxisTreatment };
  }
  const limit = input.optionalFailureLimit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0 || limit > axisCount) throw new Error("invalid_jev_optional_limit");
  const limitsInput = record(input.limits, "invalid_jev_limits");
  for (const key of Object.keys(limitsInput)) {
    if (!["maxSerialStages", "maxJudgmentsPerStage", "maxRepairs"].includes(key)) throw new Error("invalid_jev_limits");
  }
  const maxSerialStages = bounded(limitsInput.maxSerialStages, 1, jevCeilings.maxSerialStages, "invalid_jev_limits");
  const maxJudgmentsPerStage = bounded(limitsInput.maxJudgmentsPerStage, 1, jevCeilings.maxJudgmentsPerStage, "invalid_jev_limits");
  const maxRepairs = bounded(limitsInput.maxRepairs, 0, jevCeilings.maxRepairs, "invalid_jev_limits");
  const budgetsInput = record(input.budgets, "invalid_jev_budgets");
  for (const key of Object.keys(budgetsInput)) if (!["answerMs", "jevMs"].includes(key)) throw new Error("invalid_jev_budgets");
  return { axes, optionalFailureLimit: limit,
    limits: { maxSerialStages, maxJudgmentsPerStage, maxRepairs },
    budgets: { answerMs: bounded(budgetsInput.answerMs, jevCeilings.answerMs.min, jevCeilings.answerMs.max, "invalid_jev_budgets"),
      jevMs: bounded(budgetsInput.jevMs, jevCeilings.jevMs.min, jevCeilings.jevMs.max, "invalid_jev_budgets") },
    scope: parseScope(input.scope) };
}

// scopeは後から足した項目。以前に保存した版では既定で補い、範囲外の値は拒否する。
function parseScope(value: unknown): JevScopeSettings {
  const defaults = defaultJevSettings().scope;
  if (value === undefined) return defaults;
  const input = record(value, "invalid_jev_scope");
  for (const key of Object.keys(input)) {
    if (!["enabled", "maxQuestions", "thresholds", "supportThreshold", "confidenceThreshold", "lowConfidenceAction"].includes(key)) throw new Error("invalid_jev_scope");
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("invalid_jev_scope");
  const thresholds = { ...defaults.thresholds };
  if (input.thresholds !== undefined) {
    const source = record(input.thresholds, "invalid_jev_scope_threshold");
    for (const key of Object.keys(source)) if (!jevScopeNoulIds.includes(key as JevScopeNoulAxis)) throw new Error("invalid_jev_scope_threshold");
    for (const axis of jevScopeNoulIds) {
      if (source[axis] === undefined) throw new Error("invalid_jev_scope_threshold");
      const threshold = source[axis];
      if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("invalid_jev_scope_threshold");
      thresholds[axis] = threshold;
    }
  }
  const action = input.lowConfidenceAction;
  if (action !== undefined && !jevLowConfidenceActions.includes(action as JevLowConfidenceAction)) throw new Error("invalid_jev_low_confidence_action");
  return { enabled: input.enabled === undefined ? defaults.enabled : input.enabled === true,
    maxQuestions: input.maxQuestions === undefined ? defaults.maxQuestions
      : bounded(input.maxQuestions, 1, Math.min(jevCeilings.maxJudgmentsPerStage, jevScopeOrder.length), "invalid_jev_scope"),
    thresholds,
    supportThreshold: input.supportThreshold === undefined ? defaults.supportThreshold : ratio(input.supportThreshold, "invalid_jev_scope_threshold"),
    confidenceThreshold: input.confidenceThreshold === undefined ? defaults.confidenceThreshold : ratio(input.confidenceThreshold, "invalid_jev_confidence"),
    lowConfidenceAction: (action as JevLowConfidenceAction | undefined) ?? defaults.lowConfidenceAction };
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function bounded(value: unknown, min: number, max: number, code: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(code);
  return value;
}

function ratio(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(code);
  return value;
}

export type JevVerdict = { accepted: boolean; failedAxes: JevAxis[]; requiredFailed: JevAxis[];
  optionalFailed: JevAxis[]; recorded: JevAxis[]; unevaluated: JevAxis[]; reason: "required" | "optional" | "none" };

// 採点に設定を当てて採否を決める。記録のみの軸は採否の件数に入れない。
// 項目の不合格は score < threshold（同点は合格）。評価しなかった軸は採否に使わない。
export function jevVerdict(scores: Partial<JevScores>, settings: JevSettings, evaluated: readonly JevAxis[] = jevQuestionIds): JevVerdict {
  const judged = jevQuestionIds.filter(axis => evaluated.includes(axis));
  const unevaluated = jevQuestionIds.filter(axis => !evaluated.includes(axis));
  const failed = judged.filter(axis => (typeof scores[axis] === "number" ? scores[axis]! : 1) < settings.axes[axis].threshold);
  const requiredFailed = failed.filter(axis => settings.axes[axis].treatment === "required");
  const optionalFailed = failed.filter(axis => settings.axes[axis].treatment === "optional");
  const recorded = judged.filter(axis => settings.axes[axis].treatment === "record");
  const overOptional = settings.optionalFailureLimit > 0 && optionalFailed.length >= settings.optionalFailureLimit;
  return { accepted: requiredFailed.length === 0 && !overOptional, failedAxes: [...requiredFailed, ...optionalFailed],
    requiredFailed, optionalFailed, recorded, unevaluated, reason: requiredFailed.length ? "required" : overOptional ? "optional" : "none" };
}

export type JevScopeDecision = {
  answerability: "answerable" | "partial" | "unclear";
  answerScope: string;
  evidenceRole?: string;
  // 候補集合の中から選ばれた主根拠。集合外は採用しない。
  primaryEvidenceId: string | null;
  rejectedPrimary?: string;
  supportStrength?: number;
  confidence?: number;
  lowConfidence: boolean;
  directives: string[];
  needsSubjectClarification: boolean; contradiction: boolean; offTopic: boolean; backgroundOnly: boolean;
  causalityDocumented: boolean; causalityUnconfirmed: boolean;
};

// 由来・きっかけ・原因を尋ねる質問かどうか。因果が資料に無いときに限定を促すために使う。
export function asksForOrigin(question: string): boolean {
  return /(きっかけ|由来|理由|なぜ|どうして|原因|契機|発端)/.test(question);
}

// 生成前の選別結果を、コード側で回答可能範囲と限定へ合成する。JEVに文章は作らせない。
export function jevScopeDecision(question: string, assessment: { answers: Record<string, ParsedAnswer>; asked: readonly string[] },
  settings: JevSettings, candidateIds: readonly string[]): JevScopeDecision {
  const scope = settings.scope;
  const noul = (axis: JevScopeNoulAxis): number | null => {
    const answer = assessment.answers[axis];
    return answer?.type === "noul" ? answer.value : null;
  };
  const at = (axis: JevScopeNoulAxis) => { const value = noul(axis); return value !== null && value >= scope.thresholds[axis]; };
  const choice = (id: string): string | null => {
    const answer = assessment.answers[id];
    return answer?.type === "choice" ? answer.choice : null;
  };
  const confidenceOf = (id: string): number | null => {
    const answer = assessment.answers[id];
    return answer && (answer.type === "choice" || answer.type === "score") && typeof answer.confidence === "number" ? answer.confidence : null;
  };
  const supportAnswer = assessment.answers[jevScopeSupportStrengthId];
  const supportStrength = supportAnswer?.type === "score" ? normalizeScore(supportAnswer) : undefined;
  // 質問していない軸は判定に使わない（評点が無い軸で採否を動かさない）。
  const answerScope = choice(jevScopeAnswerScopeId)
    ?? (at("direct_support") ? "answerable" : at("background_support") ? "partial" : "insufficient");
  const evidenceRole = choice(jevScopeEvidenceRoleId)
    ?? (at("direct_support") ? "direct" : at("background_support") ? "background" : undefined);
  const selectedPrimary = choice(jevScopePrimaryEvidenceId);
  const primaryEvidenceId = !selectedPrimary || selectedPrimary === jevScopeNoPrimary ? null
    : candidateIds.includes(selectedPrimary) ? selectedPrimary : null;
  const rejectedPrimary = selectedPrimary && selectedPrimary !== jevScopeNoPrimary && !candidateIds.includes(selectedPrimary) ? selectedPrimary : undefined;
  const confidences = [jevScopeAnswerScopeId, jevScopeEvidenceRoleId, jevScopeSupportStrengthId]
    .map(confidenceOf).filter((value): value is number => value !== null);
  const confidence = confidences.length ? Math.min(...confidences) : undefined;
  const contradiction = at("conflict_risk") || evidenceRole === "conflict";
  const offTopic = evidenceRole === "irrelevant";
  const needsSubjectClarification = !at("target_match") || answerScope === "ambiguous";
  const backgroundOnly = evidenceRole === "background" || (at("background_support") && !at("direct_support"));
  const causalityDocumented = at("causal_support");
  const causalityUnconfirmed = asksForOrigin(question) && noul("causal_support") !== null && !causalityDocumented;
  const answerability: JevScopeDecision["answerability"] = answerScope === "answerable" ? "answerable" : answerScope === "partial" ? "partial" : "unclear";
  const directives: string[] = [];
  if (contradiction) directives.push("候補資料に一致しない記述があります。断定せず、条件を示すか本人への確認を促してください。");
  if (offTopic) directives.push("候補資料が質問と無関係と判定されました。無理に答えず、不明と限定してください。");
  if (needsSubjectClarification) directives.push("対象または条件を特定できません。どの対象かを確認してください。");
  directives.push(answerability === "answerable" ? "候補資料の直接の根拠を使って答えてください。"
    : answerability === "partial" ? "答えられる範囲だけを答え、足りない部分は不明と限定してください。"
      : "直接の答えがあるか確定していません。確認できる範囲だけを答え、それ以外は不明と限定してください。");
  if (backgroundOnly) directives.push("候補資料は背景の説明です。背景として答え、質問への直接の答えとして扱わないでください。");
  if (causalityUnconfirmed) directives.push("形成の原因・由来は資料に明記されていません。因果として述べず、未確認と限定してください。");
  if (primaryEvidenceId) directives.push(`主な根拠は資料 ${primaryEvidenceId} です。ほかの資料は補助として使ってください。`);
  if (supportStrength !== undefined) directives.push(supportStrength >= scope.supportThreshold
    ? "根拠の支持は強いと判定されています。" : "根拠の支持は弱いと判定されています。言い過ぎず、確認できる範囲に留めてください。");
  return { answerability, answerScope, evidenceRole, primaryEvidenceId, ...(rejectedPrimary ? { rejectedPrimary } : {}),
    ...(supportStrength === undefined ? {} : { supportStrength }), ...(confidence === undefined ? {} : { confidence }),
    lowConfidence: confidence !== undefined && confidence < scope.confidenceThreshold, directives,
    needsSubjectClarification, contradiction, offTopic, backgroundOnly, causalityDocumented, causalityUnconfirmed };
}

// 低確信のときの控えめな写し。second-stageを選べない場合の受け皿にも使う。
export function softenForLowConfidence(decision: JevScopeDecision): JevScopeDecision {
  const answerability: JevScopeDecision["answerability"] = decision.answerability === "answerable" ? "partial" : "unclear";
  return { ...decision, answerability,
    directives: [...decision.directives, "判定の確信が低いため、確認できる範囲だけを答え、不明と限定してください。"] };
}

export function scopeDirective(decision: JevScopeDecision): string {
  return decision.directives.join("");
}
