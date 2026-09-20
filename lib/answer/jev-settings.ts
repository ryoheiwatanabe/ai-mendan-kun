import { defaultJevThresholds, jevAxisPriority, jevQuestionIds, jevThresholds, type JevAxis, type JevScores } from "../ai/jev.ts";
import { jevScopeAnswerScopeId, jevScopeEvidenceRoleId, jevScopeNoulIds, jevScopeNoPrimary,
  jevScopeOrder, jevScopePrimaryEvidenceId, jevScopeRequestedAspectId, jevScopeSupportStrengthId, jevScopeTopicPrimaryId,
  type JevScopeAspect, type JevScopeNoulAxis } from "../ai/jev-scope.ts";
import { normalizeScore, type ParsedAnswer } from "../ai/jev-primitives.ts";
import type { Bindings } from "../types.ts";
import { questionClauses } from "./compact.ts";

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
  // 候補が多いときに、独立スコアで絞ってから選別する（段階を1つ使う）。
  screening: { enabled: boolean; candidateThreshold: number; keep: number };
};
// JEVの呼び出し先。既定はTypeSafe公式HTTP。Workers AIは同じstate/questionsで比較するための選択肢。
export type JevBackend = "official" | "workers-ai";
// 複数の根拠ルートを残して探す（ビーム探索）。OFFなら現行の一本道の経路へ戻る。
// 初期値は試用の出発点であり、速度や正確さを保証する値ではない。
export type JevBeamSettings = {
  enabled: boolean;
  // 同時に残す候補ルート数（ビーム幅）。
  width: number;
  // 1巡で評価する候補ルート数（最初の候補評価を含む）。
  candidatesPerRound: number;
  // 探索の最大回数（最初の候補評価を含む）。
  maxRounds: number;
  // 追加検索と前段JEVに使える時間（回答全体の予算とは別に、この時間は超えない）。
  explorationMs: number;
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
  // 複数の根拠ルートを探すかどうか。OFFでは現行の選別・生成・点検を使う。
  beam: JevBeamSettings;
  judge: { backend: JevBackend };
};
export const jevBackends: JevBackend[] = ["official", "workers-ai"];

// 生成前の選別の初期閾値。答えに使えるかの軸は低めに、注意の軸は高めに置き、画面から変更できる。
export const defaultScopeThresholds: Record<JevScopeNoulAxis, number> = {
  target_match: .6, time_match: .6, direct_support: .6, background_support: .6, causal_support: .6, conflict_risk: .8
};
export const jevLowConfidenceActions: JevLowConfidenceAction[] = ["proceed", "second-stage", "partial", "hold"];

// 生成への指示。選別（partial）とビーム探索で同じ文面を使い、経路によって答え方を変えない。
export const partialAnswerDirective = "答えられる範囲だけを答え、足りない部分は不明と限定してください。答えられる内容を冒頭に置き、資料に無い部分は最後に一文だけ添えてください。質問が求めている項目に直接関わる近い記録があれば答えに含め、無関係な逸話を無理に足さないでください。背景の説明は背景だと明示し、質問への直接の答えとして書き換えないでください。対象や時期を特定できないときは、資料にある範囲で確認を促してください。記録に無い因果（「それが理由で」「そのため」など）は足さないでください。";
// 不明の説明は全体で一文まで。同じ限定を繰り返すと「答えられるのに不明で終えている」と判定される。
export const singleLimitationDirective = "不明・未確認の説明は全体で一文までにし、同じ限定を繰り返さないでください。";
export const noInventedCausalityDirective = "資料に無い由来や原因を付け足さないでください。質問が求めている事実（時期・専攻・担当・実績など）は資料のまま答えてください。";

// 実装側の絶対上限。ここを超える設定は保存前に拒否し、黙って丸めない。
export const jevCeilings = {
  // 3段固定をやめ、4段以上も設定できるようにする（上限は1問の実行回数ではなく、設定できる最大値）。
  maxSerialStages: 10, maxJudgmentsPerStage: 10, maxRepairs: 2,
  beam: { width: { min: 1, max: 3 }, candidatesPerRound: { min: 2, max: 6 },
    maxRounds: { min: 1, max: 3 }, explorationMs: { min: 1_000, max: 15_000 } },
  answerMs: { min: 3000, max: 60_000 }, jevMs: { min: 500, max: 15_000 }
};
// 1ルートあたり2観点（直接支持・不足）を聞くため、1巡の判定数は候補数の2倍になる。
export const jevRouteJudgmentsPerCandidate = 2;
export const jevTreatments: JevAxisTreatment[] = ["required", "optional", "record"];

const axisCount = jevQuestionIds.length;

// 初期値は現行の挙動（全軸必須・全軸合格が必要）をそのまま表す。実装者が必要な軸を選び直さない。
export function defaultJevSettings(env?: Pick<Bindings, "JEV_THRESHOLDS_JSON" | "ANSWER_TIMEOUT_MS" | "JEV_TIMEOUT_MS">): JevSettings {
  const thresholds = env?.JEV_THRESHOLDS_JSON === undefined ? defaultJevThresholds : jevThresholds(env.JEV_THRESHOLDS_JSON);
  const axes = Object.fromEntries(jevQuestionIds.map(axis =>
    [axis, { threshold: thresholds[axis], treatment: "required" as const }])) as Record<JevAxis, JevAxisSetting>;
  return { axes, optionalFailureLimit: 0,
    // 既定は現行どおり3段のままにする。上限だけを10段へ広げ、4段以上は管理画面から選ぶ。
    // 既定は現行どおり（3段・修復1回）。上限だけを広げ、増やすかどうかは管理画面で選ぶ。
    limits: { maxSerialStages: 3, maxJudgmentsPerStage: jevCeilings.maxJudgmentsPerStage,
      maxRepairs: 1 },
    // 生成側のばらつきが大きいため、既定は上限の60秒にする（環境変数で上書きできる）。
    budgets: { answerMs: integer(env?.ANSWER_TIMEOUT_MS, 60_000, jevCeilings.answerMs), jevMs: integer(env?.JEV_TIMEOUT_MS, 4_000, jevCeilings.jevMs) },
    scope: { enabled: true, maxQuestions: jevScopeOrder.length, thresholds: { ...defaultScopeThresholds },
      supportThreshold: .6, confidenceThreshold: .5, lowConfidenceAction: "proceed",
      screening: { enabled: false, candidateThreshold: 12, keep: 6 } },
    beam: { enabled: false, width: 2, candidatesPerRound: 4, maxRounds: 3, explorationMs: 5_000 },
    judge: { backend: "official" } };
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
    if (!["axes", "optionalFailureLimit", "limits", "budgets", "scope", "beam", "judge"].includes(key)) throw new Error("invalid_jev_settings_shape");
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
  // 必須の軸は必ず聞くため、判定数が必須の数より少ない設定は保存させない。
  const requiredCount = jevQuestionIds.filter(axis => axes[axis].treatment === "required").length;
  if (maxJudgmentsPerStage < requiredCount) throw new Error("invalid_jev_judgments_required");
  const maxRepairs = bounded(limitsInput.maxRepairs, 0, jevCeilings.maxRepairs, "invalid_jev_limits");
  const budgetsInput = record(input.budgets, "invalid_jev_budgets");
  for (const key of Object.keys(budgetsInput)) if (!["answerMs", "jevMs"].includes(key)) throw new Error("invalid_jev_budgets");
  return { axes, optionalFailureLimit: limit,
    limits: { maxSerialStages, maxJudgmentsPerStage, maxRepairs },
    budgets: { answerMs: bounded(budgetsInput.answerMs, jevCeilings.answerMs.min, jevCeilings.answerMs.max, "invalid_jev_budgets"),
      jevMs: bounded(budgetsInput.jevMs, jevCeilings.jevMs.min, jevCeilings.jevMs.max, "invalid_jev_budgets") },
    scope: parseScope(input.scope), beam: parseBeam(input.beam, maxJudgmentsPerStage), judge: parseJudge(input.judge) };
}

// ビーム探索の設定。古い保存値（beamなし）は既定で補い、範囲外は保存前に拒否する。
function parseBeam(value: unknown, maxJudgmentsPerStage: number): JevBeamSettings {
  const defaults = defaultJevSettings().beam;
  if (value === undefined) return defaults;
  const input = record(value, "invalid_jev_beam");
  for (const key of Object.keys(input)) {
    if (!["enabled", "width", "candidatesPerRound", "maxRounds", "explorationMs"].includes(key)) throw new Error("invalid_jev_beam");
  }
  if (typeof input.enabled !== "boolean") throw new Error("invalid_jev_beam");
  const width = bounded(input.width, jevCeilings.beam.width.min, jevCeilings.beam.width.max, "invalid_jev_beam");
  const candidatesPerRound = bounded(input.candidatesPerRound, jevCeilings.beam.candidatesPerRound.min,
    jevCeilings.beam.candidatesPerRound.max, "invalid_jev_beam");
  // 整合の検査は有効にしたときだけ行う。無効のままなら現行の経路へ戻るだけで、他の設定を縛らない。
  // 必須確認を黙って削らないよう、整合しない設定は保存前に拒否する。
  if (input.enabled) {
    if (width > candidatesPerRound) throw new Error("invalid_jev_beam_width");
    if (candidatesPerRound * jevRouteJudgmentsPerCandidate > maxJudgmentsPerStage) throw new Error("invalid_jev_beam_judgments");
  }
  return { enabled: input.enabled, width, candidatesPerRound,
    maxRounds: bounded(input.maxRounds, jevCeilings.beam.maxRounds.min, jevCeilings.beam.maxRounds.max, "invalid_jev_beam"),
    explorationMs: bounded(input.explorationMs, jevCeilings.beam.explorationMs.min, jevCeilings.beam.explorationMs.max, "invalid_jev_beam") };
}

function parseJudge(value: unknown): { backend: JevBackend } {
  if (value === undefined) return { backend: "official" };
  const input = record(value, "invalid_jev_judge");
  for (const key of Object.keys(input)) if (key !== "backend") throw new Error("invalid_jev_judge");
  if (input.backend !== undefined && !jevBackends.includes(input.backend as JevBackend)) throw new Error("invalid_jev_judge");
  return { backend: (input.backend as JevBackend | undefined) ?? "official" };
}

// scopeは後から足した項目。以前に保存した版では既定で補い、範囲外の値は拒否する。
function parseScope(value: unknown): JevScopeSettings {
  const defaults = defaultJevSettings().scope;
  if (value === undefined) return defaults;
  const input = record(value, "invalid_jev_scope");
  for (const key of Object.keys(input)) {
    if (!["enabled", "maxQuestions", "thresholds", "supportThreshold", "confidenceThreshold", "lowConfidenceAction", "screening"].includes(key)) throw new Error("invalid_jev_scope");
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
    lowConfidenceAction: (action as JevLowConfidenceAction | undefined) ?? defaults.lowConfidenceAction,
    screening: parseScreening(input.screening, defaults.screening) };
}

function parseScreening(value: unknown, defaults: JevScopeSettings["screening"]): JevScopeSettings["screening"] {
  if (value === undefined) return defaults;
  const input = record(value, "invalid_jev_screening");
  for (const key of Object.keys(input)) if (!["enabled", "candidateThreshold", "keep"].includes(key)) throw new Error("invalid_jev_screening");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("invalid_jev_screening");
  return { enabled: input.enabled === undefined ? defaults.enabled : input.enabled === true,
    candidateThreshold: input.candidateThreshold === undefined ? defaults.candidateThreshold
      : bounded(input.candidateThreshold, 2, 100, "invalid_jev_screening"),
    keep: input.keep === undefined ? defaults.keep : bounded(input.keep, 1, jevCeilings.maxJudgmentsPerStage, "invalid_jev_screening") };
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

// 段階内で実際に聞く軸。必須は必ず含め、残り枠は任意→記録のみの順に埋める。
export function evaluatedAxes(settings: JevSettings): JevAxis[] {
  const limit = Math.max(1, Math.min(jevQuestionIds.length, settings.limits.maxJudgmentsPerStage));
  const byPriority = (treatment: JevAxisTreatment) => jevAxisPriority.filter(axis => settings.axes[axis].treatment === treatment);
  const required = byPriority("required");
  return [...required, ...byPriority("optional"), ...byPriority("record")].slice(0, Math.max(limit, required.length));
}

// 保存できる判定数の下限。必須に設定した軸は必ず聞くため、その数を下回れない。
export function minimumJudgments(settings: Pick<JevSettings, "axes">): number {
  return jevQuestionIds.filter(axis => settings.axes[axis].treatment === "required").length;
}

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

// 複数の質問文があるときの、論点ごとの主根拠の選択。聞かなかった論点は evaluated=false。
export type JevScopeTopicSelection = { query: string; primaryEvidenceId: string | null; evaluated: boolean; confidence?: number };

export type JevScopeDecision = {
  answerability: "answerable" | "partial" | "unclear";
  answerScope: string;
  // 質問が求めている項目。聞かなかった場合は付けない。
  requestedAspect?: JevScopeAspect;
  // 複数の質問文があるときだけ、論点ごとの選択を持つ。1つのときは付けない。
  topics?: JevScopeTopicSelection[];
  evidenceRole?: string;
  // 候補集合の中から選ばれた主根拠。集合外は採用しない。
  primaryEvidenceId: string | null;
  rejectedPrimary?: string;
  supportStrength?: number;
  confidence?: number;
  lowConfidence: boolean;
  directives: string[];
  needsSubjectClarification: boolean; contradiction: boolean; offTopic: boolean; backgroundOnly: boolean;
  // 直接の支持・背景の支持が、判定した範囲で満たされているか（聞いていない軸は付けない）。
  directSupported?: boolean; backgroundSupported?: boolean;
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
  const requestedAspect = choice(jevScopeRequestedAspectId);
  const primaryEvidenceId = !selectedPrimary || selectedPrimary === jevScopeNoPrimary ? null
    : candidateIds.includes(selectedPrimary) ? selectedPrimary : null;
  const rejectedPrimary = selectedPrimary && selectedPrimary !== jevScopeNoPrimary && !candidateIds.includes(selectedPrimary) ? selectedPrimary : undefined;
  // 複数の質問文があるときは、論点ごとの選択を写す。集合外のIDは採用せず、聞かなかった論点は未評価のまま残す。
  const clauses = questionClauses(question);
  const topics = clauses.length > 1 ? clauses.map((query, index): JevScopeTopicSelection => {
    const id = jevScopeTopicPrimaryId(index);
    const answer = assessment.answers[id];
    const evaluated = assessment.asked.includes(id) && answer?.type === "choice";
    const selected = answer?.type === "choice" ? answer.choice : null;
    const primaryEvidenceId = !selected || selected === jevScopeNoPrimary ? null
      : candidateIds.includes(selected) ? selected : null;
    const topicConfidence = evaluated ? confidenceOf(id) : null;
    return { query, primaryEvidenceId, evaluated, ...(topicConfidence === null ? {} : { confidence: topicConfidence }) };
  }) : undefined;
  // 主な根拠の選択も確信度の対象に含める（none_of_the_aboveでも同じ）。
  const confidences = [jevScopeAnswerScopeId, jevScopeEvidenceRoleId, jevScopeSupportStrengthId, jevScopePrimaryEvidenceId]
    .map(confidenceOf).filter((value): value is number => value !== null)
    // 聞いた論点の確信度も、低確信の判定に含める。
    .concat((topics ?? []).flatMap(topic => topic.confidence === undefined ? [] : [topic.confidence]));
  const confidence = confidences.length ? Math.min(...confidences) : undefined;
  const contradiction = at("conflict_risk") || evidenceRole === "conflict";
  // 直接の支持・背景の支持を、判定した軸の範囲だけで写す。聞いていない軸は付けない。
  // 矛盾があるときは、直接支持が高くても「十分」とみなさない。
  const directSupported = noul("direct_support") === null ? undefined : at("direct_support") && !contradiction;
  const backgroundSupported = noul("background_support") === null ? undefined : at("background_support");
  const offTopic = evidenceRole === "irrelevant";
  // 聞いていない軸は「不明」として扱い、閾値未満と混同しない。
  const needsSubjectClarification = (noul("target_match") !== null && !at("target_match")) || answerScope === "ambiguous";
  const backgroundOnly = evidenceRole === "background" || (at("background_support") && !at("direct_support"));
  const causalityDocumented = at("causal_support");
  // 資料に因果が明記されていなければ、由来を尋ねていなくても因果として断定させない。
  const causalityUnconfirmed = noul("causal_support") !== null && !causalityDocumented;
  const answerability: JevScopeDecision["answerability"] = answerScope === "answerable" ? "answerable" : answerScope === "partial" ? "partial" : "unclear";
  const directives: string[] = [];
  if (contradiction) directives.push("候補資料に一致しない記述があります。断定せず、条件を示すか本人への確認を促してください。");
  if (offTopic) directives.push("候補資料が質問と無関係と判定されました。無理に答えず、不明と限定してください。");
  if (needsSubjectClarification) directives.push("対象または条件を特定できません。どの対象かを確認してください。");
  directives.push(answerability === "answerable" ? "候補資料の直接の根拠を使って答えてください。"
    : answerability === "partial" ? partialAnswerDirective
      : "直接の答えがあるか確定していません。答えられる内容を冒頭に置き、確認できる範囲だけを答え、それ以外は不明と限定してください。" + singleLimitationDirective);
  if (backgroundOnly) directives.push("候補資料は背景の説明です。背景として答え、質問への直接の答えとして扱わないでください。");
  if (causalityUnconfirmed) directives.push(asksForOrigin(question)
    // 由来を尋ねられたときは、資料に明記された理由だけを資料の言い方の範囲で答える。
    // 「資料に理由が無い」と断定させると、実際は明記されている場合に矛盾した回答になる。
    ? "由来・理由は、資料に明記されている範囲だけを資料の言い方のまま答えてください。書かれていない部分は「そこは資料にありません」と一文だけ添え、推測で原因を補わないでください。"
    // 由来を尋ねていない質問に「未確認」と書かせると、答えられる事実まで引っ込めてしまう。
    // 付け足しの禁止だけを伝え、答えられる範囲はそのまま答えさせる。
    : noInventedCausalityDirective);
  if (primaryEvidenceId) directives.push(`主な根拠は資料 ${primaryEvidenceId} です。ほかの資料は補助として使ってください。`);
  if (supportStrength !== undefined) directives.push(supportStrength >= scope.supportThreshold
    ? "根拠の支持は強いと判定されています。" : "根拠の支持は弱いと判定されています。言い過ぎず、確認できる範囲に留めてください。");
  return { answerability, answerScope, ...(requestedAspect ? { requestedAspect: requestedAspect as JevScopeAspect } : {}),
    ...(topics ? { topics } : {}), evidenceRole, primaryEvidenceId, ...(rejectedPrimary ? { rejectedPrimary } : {}),
    ...(supportStrength === undefined ? {} : { supportStrength }), ...(confidence === undefined ? {} : { confidence }),
    lowConfidence: confidence !== undefined && confidence < scope.confidenceThreshold, directives,
    needsSubjectClarification, contradiction, offTopic, backgroundOnly,
    ...(directSupported === undefined ? {} : { directSupported }),
    ...(backgroundSupported === undefined ? {} : { backgroundSupported }),
    causalityDocumented, causalityUnconfirmed };
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
