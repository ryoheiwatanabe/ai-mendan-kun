import type { AnswerProvider, DiagnosticsCallback, Evidence } from "../types.ts";
import type { KnowledgeRepository } from "../knowledge/repository.ts";
import { jevQuestionIds, type JevAxis, type JevJudge } from "../ai/jev.ts";
import { checkCompact, minimalHistory, normalizeCandidateEvidence, parseCompact, unknownEvidenceIds,
  type CompactCandidate, type CompactInput } from "./compact.ts";
import { measureText } from "./length-policy.ts";
import { asksForOrigin, evaluatedAxes, jevScopeDecision, jevVerdict, scopeDirective, softenForLowConfidence,
  type JevScopeDecision, type JevSettings } from "./jev-settings.ts";
import { searchTerms } from "../knowledge/text.ts";
import type { ParsedAnswer } from "../ai/jev-primitives.ts";

export type JevPipeline = { judge: JevJudge; timeoutMs: number; settings: JevSettings };
export class JevPipelineError extends Error {
  readonly code: "JEV_UNAVAILABLE" | "ANSWER_REJECTED" | "ANSWER_PROCESSING_FAILED" | "ANSWER_TIME_SHORT" | "ANSWER_HELD";
  constructor(code: "JEV_UNAVAILABLE" | "ANSWER_REJECTED" | "ANSWER_PROCESSING_FAILED" | "ANSWER_TIME_SHORT" | "ANSWER_HELD") {
    super(code); this.code = code;
  }
}
const repairInstructions: Record<string, string> = {
  target_match: "質問と履歴が指す人物・時期・会社・対象に合わせてください。",
  aspect_match: "質問で求められた項目を答え、根拠が不足する部分だけを限定してください。",
  claims_supported: "根拠が支持しない主張を削り、資料から言える内容だけを残してください。",
  no_invented_causality: "因果や由来の言い回しだけを削り、資料にある事実（時期・専攻・担当・実績など）はそのまま残してください。全体を不明にしないでください。",
  no_scope_expansion: "数値・利益の帰属・担当範囲・時期・条件・否定を資料のまま保ってください。",
  no_unnecessary_abstention: "資料で答えられる事実はそのまま残し、不明な部分だけを短く限定してください。答え全体を不明にしないでください。答えられる内容を冒頭に置き、不明・未確認の説明は全体で一文だけにしてください。質問が指す場面（学校・会社など）の記録が無いときも、資料にある同じ人物の近い記録（同じ時期の経験・学び・関心）を答えに含めてください。記録に無い因果は足さないでください。",
  length_exceeded: "lengthBudget.max以内に短くし、質問への答えと必要な限定を残してください。",
  unsupported_name: "名前は資料のnamesをそのまま返すか、名前を明記した原文だけを返してください。",
  unknown_evidence: "今回渡した根拠のIDだけを指定してください。",
  missing_evidence_ids: "回答を支える根拠のIDを付けてください。",
  invalid_compact_payload: "JSONを{text,answerability,evidenceIds}の形式に直してください。本文はtextに一度だけ書きます。"
};

// 上限だけが理由で通らない候補を、文の切れ目まで削って収める。
// 内容は足さず、元の候補の先頭から使う。1文も収まらない場合は削らない。
export function trimToBudget(text: string, max: number): string | null {
  const sentences = text.split(/(?<=[。！？!?])/u).map(sentence => sentence.trim()).filter(Boolean);
  let kept = "";
  for (const sentence of sentences) {
    const next = kept + sentence;
    if (measureText(next) > max) break;
    kept = next;
  }
  return kept && kept !== text ? kept : null;
}

type VerifiedDeps = { provider: AnswerProvider; repository: KnowledgeRepository;
  jev: JevPipeline; diagnostics?: DiagnosticsCallback; deadline: number;
  // ビーム探索の追加検索。質問とルートの見出しから組み立てたクエリで、承認済みの候補だけを返す。
  search?: (query: string, signal: AbortSignal) => Promise<Evidence[]> };
type ScopeOutcome = { directive: string; decision: JevScopeDecision; hold: boolean; stages: number };

// 絞り込みでJEVへ渡す候補は、既存の検索順位で明示的に決める。
// 範囲外へ落ちる候補は、無言で0点にせず、件数と理由を残す。
export function screeningSelection(evidence: Evidence[], limit = 10): { sent: Evidence[]; dropped: Evidence[] } {
  const ranked = [...evidence].sort((left, right) => left.rank - right.rank);
  return { sent: ranked.slice(0, limit), dropped: ranked.slice(limit) };
}

// 1問で使うJEVの段階を数える台帳。上限を超える段階は始めない。
// screening / 選別 / 2段目 / 最終点検 / 修復後の点検を、同じ台帳で数える。
class StageLedger {
  private readonly max: number;
  private used = 0;
  constructor(max: number) { this.max = max; }
  get count(): number { return this.used; }
  get remaining(): number { return Math.max(0, this.max - this.used); }
  // 次段に必要な残り（needはこの段を含む数）が無ければfalse。
  spend(need = 1): boolean {
    if (this.max - this.used < need) return false;
    this.used += 1;
    return true;
  }
}

// ---- ビーム探索（#4）----------------------------------------------
// 候補は「根拠ID集合」を持つルートとして扱い、JEVは支持と不足だけを付ける。
// GLMの生成は最後の1回（と必要な修復1回）だけで、ルートごとに回答は作らない。
export type AnswerRoute = { id: string; evidence: Evidence[]; support?: number; target?: number };

// 最初の候補は、上位の似た資料だけで作らない。既存の検索順位・文書の多様性・事実・見出しの
// 4通りから、異なる根拠の組み合わせを作る（新しいLLM呼び出しはしない）。
export function initialRoutes(evidence: Evidence[], limit: number, terms: string[]): AnswerRoute[] {
  const ranked = [...evidence].sort((left, right) => left.rank - right.rank);
  const routes: AnswerRoute[] = [];
  const add = (id: string, items: Evidence[]) => {
    const unique = [...new Map(items.map(item => [item.id, item])).values()];
    if (unique.length && routes.length < limit) routes.push({ id, evidence: unique });
  };
  add("ranked", ranked.slice(0, 6));
  // 同じ文書ばかりに寄せない。文書ごとの最上位を先に並べる。
  const documents = new Map<string, Evidence>();
  for (const item of ranked) if (!documents.has(item.documentId)) documents.set(item.documentId, item);
  add("documents", [...documents.values()]);
  // 数値や時期の事実（Exact Fact）を優先して含める。
  const facts = ranked.filter(item => item.kind === "exact_fact");
  if (facts.length) add("facts", [...facts, ...ranked].slice(0, 6));
  // 見出しが質問の語と重なる資料を優先する。
  const titled = ranked.filter(item => terms.some(term => item.title.includes(term)));
  if (titled.length) add("titles", [...titled, ...ranked].slice(0, 6));
  return routes;
}

// ルートが答えに使えるか。直接の支持があり、対象一致も回答側の閾値に届くときだけ、そのルートを採る。
// 選別の閾値（緩め）だけだと、対象がずれたルートで答えを作り、最終点検で落ちる。
function routeSufficient(route: AnswerRoute, settings: JevSettings): boolean {
  return (route.support ?? 0) >= settings.scope.thresholds.direct_support
    && (route.target ?? 0) >= settings.axes.target_match.threshold;
}

// 不足するルートだけを、質問とルートの見出しからコードで組み立てたクエリで広げる。
async function expandRoute(route: AnswerRoute, input: CompactInput, deps: VerifiedDeps, signal: AbortSignal) {
  if (!deps.search) return { route, added: 0 };
  const query = [input.question, ...route.evidence.slice(0, 3).map(item => item.title).filter(Boolean)].join("\n");
  const known = new Set(route.evidence.map(item => item.id));
  const found = (await deps.search(query, signal)).filter(item => !known.has(item.id)).slice(0, 2);
  if (!found.length) return { route, added: 0 };
  deps.diagnostics?.({ code: "beam_expanded", count: found.length, ids: found.map(item => item.id) });
  return { route: { ...route, evidence: [...route.evidence, ...found].slice(0, 8) }, added: found.length };
}

// ビーム探索の本体。ルートを評価して、不足するルートを追加検索で広げる。
// 返すのは「元の検索に無かった根拠」だけ。回答の作り方（選別・生成・点検）は現行の経路のまま使う。
// 探索で狭いルートへ絞ると、答えられる根拠を失って最終点検で落ちるため、成果は足す方向にだけ使う。
async function exploreRoutes(input: CompactInput, deps: VerifiedDeps, history: CompactInput["history"],
  budget: StageLedger, signal: AbortSignal): Promise<Evidence[] | undefined> {
  const settings = deps.jev.settings, beam = settings.beam;
  if (!beam.enabled) { deps.diagnostics?.({ code: "beam_skipped", count: 1, reason: "disabled" }); return undefined; }
  if (!deps.jev.judge.checkRoutes) { deps.diagnostics?.({ code: "beam_skipped", count: 1, reason: "judge_unsupported" }); return undefined; }
  // 選別・生成・修復の段階を先に確保し、残りだけを探索に使う。
  const rounds = Math.max(0, Math.min(beam.maxRounds, settings.limits.maxSerialStages - 2 - settings.limits.maxRepairs));
  if (!rounds) { deps.diagnostics?.({ code: "beam_skipped", count: 1, reason: "stage_limit" }); return undefined; }
  let routes = initialRoutes(input.evidence, beam.candidatesPerRound, searchTerms(input.question));
  if (routes.length < 2) { deps.diagnostics?.({ code: "beam_skipped", count: 1, reason: "routes_insufficient" }); return undefined; }
  const started = performance.now();
  // 最終生成と点検の時間を先に確保する。探索は自分の予算と段階の残りの中だけで行う。
  const exploreUntil = Math.min(started + beam.explorationMs, deps.deadline - settings.budgets.jevMs - 2_000);
  const additions = new Map<string, Evidence>();
  let best: AnswerRoute | undefined;
  for (let round = 1; round <= rounds; round++) {
    if (performance.now() >= exploreUntil) { deps.diagnostics?.({ code: "beam_skipped", count: 1, reason: "time_insufficient" }); break; }
    if (!budget.spend(1)) { deps.diagnostics?.({ code: "beam_skipped", count: 1, reason: "stage_limit" }); break; }
    deps.diagnostics?.({ code: "beam_attempt", count: routes.length, reason: `round_${round}` });
    const assessment = await deps.jev.judge.checkRoutes({ question: input.question, history, routes }, signal);
    const scored = routes.map(route => ({ ...route, ...assessment.scores[route.id] }))
      .sort((left, right) => ((right.support ?? 0) + (right.target ?? 0)) - ((left.support ?? 0) + (left.target ?? 0)));
    deps.diagnostics?.({ code: "beam_complete", count: scored.length, reason: `round_${round}`,
      scores: Object.fromEntries(scored.flatMap(route => [[`${route.id}.support`, Math.round((route.support ?? 0) * 100) / 100],
        [`${route.id}.target`, Math.round((route.target ?? 0) * 100) / 100]])) });
    routes = scored;
    best = scored[0];
    if (best && routeSufficient(best, settings)) break;
    if (round >= rounds) break;
    // 残したルートだけを追加検索で広げる。新しい根拠が増えなければ、同じ候補を回しているとみなして止める。
    const expanded: AnswerRoute[] = [];
    let added = 0;
    for (const route of scored.slice(0, Math.max(1, beam.width))) {
      if (performance.now() >= exploreUntil) break;
      const result = await expandRoute(route, input, deps, signal);
      expanded.push(result.route);
      added += result.added;
      // 元の検索に無い根拠だけを、生成へ足す候補として集める。
      for (const item of result.route.evidence) if (!input.evidence.some(current => current.id === item.id)) additions.set(item.id, item);
    }
    if (!added) break;
    routes = [...new Map(expanded.map(route => [route.id, route])).values()].slice(0, beam.candidatesPerRound);
  }
  return additions.size ? [...additions.values()] : undefined;
}


// 候補が多いときだけ、既存の検索順位でJEVへ渡す候補を明示して絞り込む（段階を1つ使う）。
// 無言で0点扱いにはしない。範囲外へ落とした候補は件数と理由を残す。
async function selectCandidates(input: CompactInput, deps: VerifiedDeps, history: CompactInput["history"],
  budget: StageLedger, signal: AbortSignal): Promise<Evidence[]> {
  const screening = deps.jev.settings.scope.screening;
  if (!screening.enabled || input.evidence.length <= screening.candidateThreshold) return input.evidence;
  if (!deps.jev.judge.screenCandidates) { deps.diagnostics?.({ code: "scope_skipped", count: 1, reason: "judge_unsupported" }); return input.evidence; }
  // 絞り込みと最終点検の2段は必ず残す。
  if (!budget.spend(2)) { deps.diagnostics?.({ code: "scope_skipped", count: 1, reason: "stage_limit" }); return input.evidence; }
  const { sent, dropped } = screeningSelection(input.evidence);
  const started = performance.now();
  deps.diagnostics?.({ code: "screening_attempt", count: sent.length, reason: "retrieval_rank" });
  // 10件を超える分は、スコア未評価のまま落とさず、範囲外として記録する。
  if (dropped.length) deps.diagnostics?.({ code: "screening_dropped", count: dropped.length, reason: "beyond_screen_limit" });
  try {
    const scores = await deps.jev.judge.screenCandidates({ question: input.question, history, evidence: sent, limit: sent.length }, signal);
    const kept = [...sent].sort((left, right) => (scores[right.id] ?? 0) - (scores[left.id] ?? 0) || left.rank - right.rank)
      .slice(0, Math.max(1, Math.min(screening.keep, sent.length)));
    deps.diagnostics?.({ code: "screening_complete", count: kept.length, latencyMs: Math.round(performance.now() - started),
      ids: kept.map(item => item.id) });
    return kept;
  } catch (error) {
    signal.throwIfAborted();
    // 絞り込みの失敗は回答を止めない。全候補で選別と点検を続ける。
    deps.diagnostics?.({ code: "screening_error", count: 1, latencyMs: Math.round(performance.now() - started) });
    return input.evidence;
  }
}

// 生成前の選別（JEV①）。失敗・時間切れでは回答を止めず、最終点検は必ず行う。
async function resolveAnswerScope(input: CompactInput, deps: VerifiedDeps, history: CompactInput["history"],
  budget: StageLedger, signal: AbortSignal): Promise<ScopeOutcome | undefined> {
  const settings = deps.jev.settings;
  const judge = deps.jev.judge;
  if (!settings.scope.enabled) { deps.diagnostics?.({ code: "scope_skipped", count: 1, reason: "disabled" }); return undefined; }
  if (!judge.checkScope) { deps.diagnostics?.({ code: "scope_skipped", count: 1, reason: "judge_unsupported" }); return undefined; }
  if (deps.deadline - performance.now() < settings.budgets.jevMs + 2_000) {
    deps.diagnostics?.({ code: "scope_skipped", count: 1, reason: "time_insufficient" }); return undefined;
  }
  // 選別と最終点検の2段は必ず残す。
  if (!budget.spend(2)) { deps.diagnostics?.({ code: "scope_skipped", count: 1, reason: "stage_limit" }); return undefined; }
  const maxJudgments = Math.max(1, Math.min(settings.scope.maxQuestions, settings.limits.maxJudgmentsPerStage));
  const candidateIds = input.evidence.map(item => item.id);
  const ask = async (tieBreak: boolean) => {
    const started = performance.now();
    deps.diagnostics?.({ code: "scope_attempt", count: maxJudgments, ...(tieBreak ? { reason: "tie_break" } : {}) });
    const assessment = await judge.checkScope!({ question: input.question, history, evidence: input.evidence, maxJudgments, tieBreak }, signal);
    const decision = jevScopeDecision(input.question, assessment, settings, candidateIds);
    deps.diagnostics?.({ code: "scope_complete", count: assessment.asked.length, latencyMs: Math.round(performance.now() - started),
      inputTokens: assessment.usage?.input, outputTokens: assessment.usage?.output, scopeScores: noulScores(assessment.answers),
      scopeChoice: decision.answerScope, ...(decision.confidence === undefined ? {} : { confidence: decision.confidence }),
      ...(decision.supportStrength === undefined ? {} : { supportStrength: decision.supportStrength }),
      ...(decision.rejectedPrimary ? { ids: [decision.rejectedPrimary] } : {}) });
    if (decision.rejectedPrimary) deps.diagnostics?.({ code: "scope_primary_rejected", count: 1 });
    return decision;
  };
  try {
    let decision = await ask(false);
    let stages = 1;
    if (decision.lowConfidence) {
      const action = settings.scope.lowConfidenceAction;
      deps.diagnostics?.({ code: "scope_low_confidence", count: 1, reason: action });
      // 2段目も最終点検の1段を残してから始める。
      if (action === "second-stage" && budget.spend(2) && deps.deadline - performance.now() > settings.budgets.jevMs + 2_000) {
        decision = await ask(true); stages = 2;
        if (decision.lowConfidence) decision = softenForLowConfidence(decision);
      } else if (action === "partial" || action === "second-stage") decision = softenForLowConfidence(decision);
      else if (action === "hold") return { directive: scopeDirective(decision), decision, hold: true, stages };
    }
    return { directive: scopeDirective(decision), decision, hold: false, stages };
  } catch (error) {
    signal.throwIfAborted();
    // 選別の失敗は回答を止めない。最終点検は別に必ず通す。
    deps.diagnostics?.({ code: "scope_error", count: 1 });
    deps.diagnostics?.({ code: "scope_skipped", count: 1, reason: "scope_unavailable" });
    return undefined;
  }
}

// 選別のスコアは型が違うため、Noulの値だけを取り出して記録する。
function noulScores(answers: Record<string, ParsedAnswer>): Record<string, number> {
  return Object.fromEntries(Object.entries(answers).flatMap(([id, answer]) => answer.type === "noul" ? [[id, answer.value]] : []));
}

// 1問につき生成1/最大2。JEVの段階は設定のmaxSerialStagesを超えない（通常2・修復込み3）。
export async function verifiedCompactAnswer(input: CompactInput, deps: VerifiedDeps, signal: AbortSignal): Promise<CompactCandidate> {
  if (!deps.provider.generateCompact) throw new JevPipelineError("ANSWER_PROCESSING_FAILED");
  const settings = deps.jev.settings;
  const budget = new StageLedger(settings.limits.maxSerialStages);
  try {
    const history = minimalHistory(input.history);
    const screened = await selectCandidates(input, deps, history, budget, signal);
    const scoped = screened === input.evidence ? input : { ...input, evidence: screened };
    // ビーム探索は、答えに使える根拠を「足す」ためだけに使う（選別・生成・点検は現行の経路のまま）。
    const added = await exploreRoutes(scoped, deps, history, budget, signal);
    const merged = added?.length
      ? { ...scoped, evidence: [...scoped.evidence, ...added].slice(0, 10) }
      : scoped;
    const scope = await resolveAnswerScope(merged, deps, history, budget, signal);
    if (scope?.hold) throw new JevPipelineError("ANSWER_HELD");
    // 文章の指示だけでなく、コードで決めた範囲も構造化して渡す。
    const plan = scope ? { directive: scope.directive, answerability: scope.decision.answerability,
      primaryEvidenceId: scope.decision.primaryEvidenceId, backgroundOnly: scope.decision.backgroundOnly,
      causalityUnconfirmed: scope.decision.causalityUnconfirmed,
      ...(scope.decision.supportStrength === undefined ? {} : { supportStrength: scope.decision.supportStrength }) } : undefined;
    const generationInput = { ...merged, history, ...(plan ? { plan } : {}) };
    // 段階内で聞く軸は設定に従う。必須の軸は必ず含め、評価しない軸は採否に使わない。
    const evaluated = evaluatedAxes(settings);
    const repairs = Math.max(0, Math.min(settings.limits.maxRepairs, budget.remaining));
    let previous: CompactCandidate | undefined, repair: string | undefined;
    let generationMs = 0, judgeMs = 0;
    const current = async () => {
      signal.throwIfAborted();
      // ビーム探索で足した根拠も含めて、公開状態と本文を送信直前にもう一度照合する。
      if (!await deps.repository.revalidateSnapshot(generationInput.evidence)) throw new JevPipelineError("ANSWER_PROCESSING_FAILED");
      signal.throwIfAborted();
    };
    for (let attempt = 0; attempt <= repairs; attempt++) {
      const reserve = attempt ? Math.round(generationMs * 1.2) + Math.max(Math.round(judgeMs), 500) + 500 : 0;
      if (performance.now() >= deps.deadline - reserve) {
        if (attempt) deps.diagnostics?.({ code: "repair_skipped", count: 1, reason: "time_insufficient" });
        throw new JevPipelineError(attempt ? "ANSWER_TIME_SHORT" : "ANSWER_PROCESSING_FAILED");
      }
      // 点検の段が残っていなければ、新しい候補は作らない。
      if (!budget.spend(1)) {
        deps.diagnostics?.({ code: "repair_skipped", count: 1, reason: "stage_limit" });
        throw new JevPipelineError(attempt ? "ANSWER_REJECTED" : "ANSWER_PROCESSING_FAILED");
      }
      await current();
      if (attempt) deps.diagnostics?.({ code: "repair_attempted", count: 1 });
      const started = performance.now();
      deps.diagnostics?.({ code: "generation_attempt", count: 1 });
      let candidate: CompactCandidate;
      try {
        const generated = await deps.provider.generateCompact({ ...generationInput, previous, repair }, signal);
        if (!attempt) generationMs = performance.now() - started;
        deps.diagnostics?.({ code: attempt ? "repair_complete" : "generation_complete", count: 1,
          latencyMs: Math.round(performance.now() - started), inputTokens: generated.usage?.input, outputTokens: generated.usage?.output });
        candidate = parseCompact(generated.candidate);
        // 版のIDで引用された分は、渡した根拠へ寄せる（表記揺れを機械確認で落とさない）。
        const normalized = normalizeCandidateEvidence(candidate, generationInput.evidence);
        if (normalized.normalized.length) {
          deps.diagnostics?.({ code: "evidence_id_normalized", count: normalized.normalized.length, ids: normalized.normalized });
          candidate = normalized.candidate;
        }
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof Error && error.message === "invalid_compact_payload" && !attempt) {
          repair = repairInstructions.invalid_compact_payload;
          continue;
        }
        throw new JevPipelineError("ANSWER_PROCESSING_FAILED");
      }
      let mechanical = checkCompact(candidate, generationInput);
      // 長さだけが理由で通らないときは、修復を使い切った最終試行で文の切れ目まで削る。
      // 削った本文も同じ点検へ通し、新しい内容は足さない。
      if (mechanical === "length_exceeded" && attempt >= repairs) {
        const trimmed = trimToBudget(candidate.text, generationInput.lengthBudget.max);
        if (trimmed) {
          candidate = { ...candidate, text: trimmed };
          deps.diagnostics?.({ code: "length_trimmed", count: 1, reason: "final_attempt" });
          mechanical = checkCompact(candidate, generationInput);
        }
      }
      if (mechanical) {
        const unknown = mechanical === "unknown_evidence" ? unknownEvidenceIds(candidate, generationInput.evidence) : [];
        deps.diagnostics?.({ code: "unsupported_claim", count: 1, reason: mechanical, ...(unknown.length ? { ids: unknown } : {}) });
        if (attempt >= repairs) throw new JevPipelineError("ANSWER_REJECTED");
        previous = candidate;
        // 長さだけの差し戻しは、実際の字数と上限を伝える。一般的な「短く」より直りやすい。
        repair = mechanical === "length_exceeded"
          ? `回答が長すぎます（${measureText(candidate.text)}字）。lengthBudget.max（${generationInput.lengthBudget.max}字）以内へ、質問への答えと必要な限定を残して短くしてください。`
          // 根拠IDの取り違えは、渡したIDを具体的に示す。同じIDを再び返すのを防ぐ。
          : mechanical === "unknown_evidence"
            ? `今回渡した根拠のIDだけを指定してください。使えるID: ${generationInput.evidence.map(item => item.id).join(", ")}。根拠を付けられない文は削ってください。`
          : repairInstructions[mechanical] ?? repairInstructions.invalid_compact_payload;
        continue;
      }
      await current();
      if (performance.now() >= deps.deadline) throw new JevPipelineError("ANSWER_TIME_SHORT");
      const judgeStarted = performance.now();
      deps.diagnostics?.({ code: "jev_attempt", count: evaluated.length });
      let assessment;
      for (let attempt = 0; ; attempt++) {
        try {
          // 点検へは、生成に渡した根拠（ビーム探索で足した分を含む）をそのまま渡す。
          assessment = await deps.jev.judge.check({ question: input.question, history, evidence: generationInput.evidence,
            candidate: candidate.text, axes: evaluated, asksForOrigin: asksForOrigin(input.question),
            ...(scope ? { answerScope: scope.directive } : {}) }, signal);
          break;
        } catch {
          signal.throwIfAborted();
          // 一時的な接続失敗は1回だけ試し直す。再試行したことも記録する。
          deps.diagnostics?.({ code: "jev_error", count: 1, ...(attempt === 0 ? { reason: "retry" } : {}),
            latencyMs: Math.round(performance.now() - judgeStarted) });
          if (attempt > 0) throw new JevPipelineError("JEV_UNAVAILABLE");
        }
      }
      const decision = jevVerdict(assessment.scores, settings, evaluated);
      deps.diagnostics?.({ code: "jev_complete", count: 1, latencyMs: Math.round(performance.now() - judgeStarted),
        inputTokens: assessment.usage?.input, outputTokens: assessment.usage?.output, scores: assessment.scores });
      judgeMs = performance.now() - judgeStarted;
      if (decision.accepted) {
        await current();
        return candidate;
      }
      for (const axis of decision.failedAxes) deps.diagnostics?.({ code: "jev_rejected", count: 1, reason: axis });
      previous = candidate; repair = decision.failedAxes.map(axis => repairInstructions[axis]).join("\n");
    }
    throw new JevPipelineError("ANSWER_REJECTED");
  } finally {
    // 実際に使ったJEVの段階数を残す（上限を超えていないことの確認に使う）。
    deps.diagnostics?.({ code: "stages_used", count: budget.count });
  }
}
