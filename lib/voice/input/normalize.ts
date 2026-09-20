import { emptyContentExclusions, type ContentExclusionPolicy } from "../../security/content-exclusions.ts";
import { asksForPrivateDisclosure, isInjection } from "../../security/request.ts";
import type { DiagnosticsCallback, Turn } from "../../types.ts";
import { hasNoQuestionText, mechanicalNormalize, minimalNormalize, normalizationVersion,
  type InputEdit, type InputOrigin, type InputResolution } from "./mechanical.ts";
import { applyExplicitTerms, correctionCandidates, emptyTermDictionary, preservesCriticalTokens,
  type TermDictionary } from "./terms.ts";
import { assessInput, chooseInputCorrection, defaultInputThresholds, type InputNormalizationJudge,
  type InputThresholds } from "../../ai/jev-input.ts";

// 本体へ渡す入力の封筒。原文は変えず、有効な質問と、そこで起きた変更だけを持つ。
// 原文と有効質問はこのリクエストの間だけメモリに置き、ログ・DB・ブラウザー永続領域へ保存しない。
export type InputEnvelope = {
  rawTranscript: string;
  // 回答エンジンへ渡す文。非表示対象のときは原文をそのまま渡し、遮断はエンジン側で行う。
  effectiveQuestion: string;
  // 画面に出す文。非表示対象はここでマスクする。
  displayQuestion: string;
  inputOrigin: InputOrigin;
  edits: InputEdit[];
  resolution: InputResolution;
  normalizationVersion: string;
  blocked: boolean;
  // 質問として成立しているか。falseなら新しい検索・回答生成を始めない。
  question: boolean;
  // 重大な曖昧さで、回答を始めずに短い確認を出す状態。
  confirm: boolean;
  // 実質的な補正をしたか。画面の「音声入力を整えました」の表示条件。
  edited: boolean;
  // 短い確認や言い直しの案内。空なら表示しない。
  notice: string;
  // 補正に使ったJEVの段数。回答側の台帳の初期消費へ渡す。
  jevStages: number;
  // 正規化に使った時間(ms)。回答の全体予算から差し引く。
  elapsedMs: number;
};

export type VoiceInputDeps = {
  policy?: ContentExclusionPolicy;
  dictionary?: TermDictionary;
  // 補正の選択と意味確認を頼む判定器。無い場合は辞書までの補正だけを行う。
  judge?: InputNormalizationJudge;
  thresholds?: InputThresholds;
  diagnostics?: DiagnosticsCallback;
  history?: Turn[];
  // 補正JEV1回の上限。初期試用値は1,500ms。
  timeoutMs?: number;
  // この入力に使える残り時間。最終点検の枠を残せないときは補正JEVを省略する。
  remainingMs?: number;
  // この質問で使えるJEVの段数（未使用）。最終点検の1段を残せないときは補正JEVを省略する。
  stagesRemaining?: number;
  // 補正JEVの後ろに残す時間。保存設定のjevMs＋最終生成の予備。
  reserveMs?: number;
};

export const defaultInputTimeoutMs = 1_500;
// 保存設定が読めない場合の予備。回答側の段階（最終点検・修復）を補正で使い切らない。
export const defaultInputReserveMs = 6_000;
const ambiguousNotice = "聞き取れない部分があります。入力欄で直すか、もう一度お話しください。";

function envelope(input: { raw: string; origin: InputOrigin; policy: ContentExclusionPolicy; elapsedMs: number },
  patch: Partial<InputEnvelope> & { effectiveQuestion: string }): InputEnvelope {
  const blocked = patch.blocked === true;
  return {
    rawTranscript: input.raw,
    effectiveQuestion: patch.effectiveQuestion,
    displayQuestion: blocked ? input.policy.mask(patch.effectiveQuestion) : patch.effectiveQuestion,
    inputOrigin: input.origin,
    edits: patch.edits ?? [],
    resolution: patch.resolution ?? "none",
    normalizationVersion,
    blocked,
    question: patch.question !== false,
    confirm: patch.confirm === true,
    edited: patch.edited === true,
    notice: patch.notice ?? "",
    jevStages: patch.jevStages ?? 0,
    elapsedMs: input.elapsedMs
  };
}

// 音声・手入力の共通入口。軽い機械整形 → 公開用語辞書 → 必要なときだけJEV1回、の順に決める。
// 失敗しても質問全体を落とさない。原文を維持して続行し、答えが大きく変わる曖昧さだけ確認へ回す。
export async function normalizeVoiceInput(input: { text: string; origin: InputOrigin; alternatives?: string[] },
  deps: VoiceInputDeps, signal: AbortSignal): Promise<InputEnvelope> {
  const started = performance.now();
  signal.throwIfAborted();
  const policy = deps.policy ?? emptyContentExclusions;
  const raw = input.text;
  const done = (patch: Partial<InputEnvelope> & { effectiveQuestion: string }) =>
    envelope({ raw, origin: input.origin, policy, elapsedMs: Math.round(performance.now() - started) }, patch);
  // 原文に非表示対象が含まれる場合は、対象名も理由も復唱しない。遮断はエンジン側で行う。
  if (policy.matches(raw)) {
    deps.diagnostics?.({ code: "voice_input_blocked", count: 1 });
    return done({ effectiveQuestion: raw, resolution: "blocked", blocked: true });
  }
  // 用語の置き換えで、指示の上書きや非公開情報の要求を別の文へ言い換えない。
  // 疑いのある原文は、補正せずそのまま渡し、既存の検査に掛ける。
  if (isInjection(raw) || asksForPrivateDisclosure(raw)) {
    deps.diagnostics?.({ code: "voice_input_skipped", count: 1, reason: "sensitive_raw" });
    return done({ effectiveQuestion: raw, resolution: "kept" });
  }
  // 手入力は空白の整理だけを既定にする。フィラー除去・用語補正・補正JEVを行わない。
  const manual = input.origin === "manual";
  const mechanical = manual ? minimalNormalize(raw) : mechanicalNormalize(raw);
  // フィラーだけ・空白だけの発話では、新しい検索も回答生成も始めない。
  if (hasNoQuestionText(mechanical.text)) {
    return done({ effectiveQuestion: mechanical.text, resolution: "mechanical", question: false });
  }
  if (manual) {
    return done({ effectiveQuestion: mechanical.text, edits: mechanical.edits,
      resolution: mechanical.edits.length ? "mechanical" : "none" });
  }
  const dictionary = deps.dictionary ?? emptyTermDictionary;
  const applied = applyExplicitTerms(mechanical.text, dictionary);
  signal.throwIfAborted();
  // 辞書の結果にも、非表示対象が混ざっていないかを確認する。
  if (policy.matches(applied.text)) {
    deps.diagnostics?.({ code: "voice_input_blocked", count: 1 });
    return done({ effectiveQuestion: raw, resolution: "blocked", blocked: true });
  }
  const edits: InputEdit[] = [...mechanical.edits, ...applied.edits];
  // 補正案は、実際に返ったSTT候補と、対応が一意でない別名からだけ作る。
  const candidates = correctionCandidates({ base: applied.text, alternatives: input.alternatives, dictionary })
    // 非表示対象を含む候補は作らない。候補経由で語を復活させない。
    .filter(candidate => !policy.matches(candidate.text));
  const base: Partial<InputEnvelope> = {
    edits, resolution: applied.edits.length ? "dictionary" : mechanical.edits.length ? "mechanical" : "none",
    edited: applied.edits.length > 0
  };
  const timeoutMs = deps.timeoutMs ?? defaultInputTimeoutMs;
  const reserveMs = deps.reserveMs ?? defaultInputReserveMs;
  // 内容の変わる疑いがある補正だけ、JEVを最大1回使う。最終点検の枠を残せないときは補正だけをやめる。
  // 段数の残りが無いときは、補正JEVで最終点検の枠を使わない。
  const stagesLeft = deps.stagesRemaining ?? 0;
  if (!deps.judge || !candidates.length || stagesLeft < 2 || (deps.remainingMs ?? 0) < timeoutMs + reserveMs) {
    if (candidates.length) deps.diagnostics?.({ code: "voice_input_skipped", count: candidates.length,
      reason: !deps.judge ? "judge_unavailable" : stagesLeft < 2 ? "stage_limit" : "time_insufficient" });
    return done({ effectiveQuestion: applied.text, ...base });
  }
  // ここから先は、採用しなくても補正JEVを1回使った回として数える（回答側の台帳と同じ数え方）。
  const stages = 1;
  try {
    // 補正JEVの上限は、この機能の設定で切る。回答の最終点検の枠は別に残す。
    // 除外を含む往復は、丸ごと落として後段へ渡さない。
    const assessment = await assessInput({ raw, base: applied.text, candidates, history: allowedHistory(deps.history ?? [], policy),
      origin: input.origin, includeKind: applied.text.length <= 12 }, deps.judge,
      AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]));
    const choice = chooseInputCorrection(assessment, candidates, deps.thresholds ?? defaultInputThresholds);
    deps.diagnostics?.({ code: "voice_input_normalize", count: candidates.length,
      latencyMs: Math.round(performance.now() - started), ...(choice.kind ? { reason: choice.kind } : {}) });
    if (choice.chosen) {
      // 数字・否定・人名が変わる候補は、点数だけで採用しない。原文を維持して短い確認へ回す。
      const names = dictionary.terms.map(term => term.canonical);
      if (!policy.matches(choice.chosen.text) && preservesCriticalTokens(applied.text, choice.chosen.text, names)) {
        deps.diagnostics?.({ code: "voice_input_edited", count: choice.chosen.edits.length });
        return done({ effectiveQuestion: choice.chosen.text, edits: [...edits, ...choice.chosen.edits],
          resolution: "jev", edited: true, jevStages: stages });
      }
      deps.diagnostics?.({ code: "voice_input_skipped", count: 1, reason: "critical_tokens" });
      return done({ effectiveQuestion: applied.text, ...base, jevStages: stages, resolution: "unresolved",
        confirm: true, notice: ambiguousNotice });
    }
    // 候補が競合して決められないときは、回答を始めずに短い確認へ回す。勝手に確定しない。
    if (choice.reason === "clarify") {
      return done({ effectiveQuestion: applied.text, ...base, jevStages: stages, resolution: "unresolved",
        confirm: true, notice: ambiguousNotice });
    }
    return done({ effectiveQuestion: applied.text, ...base, jevStages: stages,
      resolution: applied.edits.length ? "dictionary" : "kept" });
  } catch (error) {
    signal.throwIfAborted();
    // 補正JEVの失敗・時間切れでは、補正だけをやめて本体を続行する。自動再試行はしない。
    deps.diagnostics?.({ code: "voice_input_skipped", count: candidates.length, reason: "jev_failed" });
    return done({ effectiveQuestion: applied.text, ...base, jevStages: stages,
      resolution: applied.edits.length ? "dictionary" : "kept" });
  }
}

// 補正JEVへ渡す履歴。除外を含む往復は、質問と回答の対で丸ごと落とす。
// 除外された語を、補正の手掛かりとして復活させない。
function allowedHistory(history: Turn[], policy: ContentExclusionPolicy): Turn[] {
  const kept: Turn[] = [];
  for (let index = 0; index + 1 < history.length; index += 2) {
    const pair = [history[index], history[index + 1]];
    if (pair.some(turn => policy.matches(turn.content))) continue;
    kept.push(...pair);
  }
  return kept;
}
