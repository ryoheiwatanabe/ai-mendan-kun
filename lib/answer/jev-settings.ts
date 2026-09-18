import { defaultJevThresholds, jevQuestionIds, jevThresholds, type JevAxis, type JevScores } from "../ai/jev.ts";
import type { Bindings } from "../types.ts";

// 各軸の扱い。required=1つでも不合格なら不採用、optional=不合格件数に数える、record=採否に使わない。
export type JevAxisTreatment = "required" | "optional" | "record";
export type JevAxisSetting = { threshold: number; treatment: JevAxisTreatment };
export type JevSettings = {
  axes: Record<JevAxis, JevAxisSetting>;
  // 任意軸の不合格がこの件数以上なら不採用。0は「任意軸だけでは不採用にしない」。
  optionalFailureLimit: number;
  // 直列段階・段階内の独立判定・修復回数。実装が対応する範囲を超える値は保存させない。
  limits: { maxSerialStages: number; maxJudgmentsPerStage: number; maxRepairs: number };
  // 回答全体とJEV1回の時間予算（ミリ秒）。
  budgets: { answerMs: number; jevMs: number };
};

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
    budgets: { answerMs: integer(env?.ANSWER_TIMEOUT_MS, 25_000, jevCeilings.answerMs), jevMs: integer(env?.JEV_TIMEOUT_MS, 4_000, jevCeilings.jevMs) } };
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
    if (!["axes", "optionalFailureLimit", "limits", "budgets"].includes(key)) throw new Error("invalid_jev_settings_shape");
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
      jevMs: bounded(budgetsInput.jevMs, jevCeilings.jevMs.min, jevCeilings.jevMs.max, "invalid_jev_budgets") } };
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function bounded(value: unknown, min: number, max: number, code: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(code);
  return value;
}

export type JevVerdict = { accepted: boolean; failedAxes: JevAxis[]; requiredFailed: JevAxis[];
  optionalFailed: JevAxis[]; recorded: JevAxis[]; reason: "required" | "optional" | "none" };

// 採点に設定を当てて採否を決める。記録のみの軸は採否の件数に入れない。
// 項目の不合格は score < threshold（同点は合格）。
export function jevVerdict(scores: JevScores, settings: JevSettings): JevVerdict {
  const failed = jevQuestionIds.filter(axis => scores[axis] < settings.axes[axis].threshold);
  const requiredFailed = failed.filter(axis => settings.axes[axis].treatment === "required");
  const optionalFailed = failed.filter(axis => settings.axes[axis].treatment === "optional");
  const recorded = jevQuestionIds.filter(axis => settings.axes[axis].treatment === "record");
  const overOptional = settings.optionalFailureLimit > 0 && optionalFailed.length >= settings.optionalFailureLimit;
  return { accepted: requiredFailed.length === 0 && !overOptional, failedAxes: [...requiredFailed, ...optionalFailed],
    requiredFailed, optionalFailed, recorded, reason: requiredFailed.length ? "required" : overOptional ? "optional" : "none" };
}
