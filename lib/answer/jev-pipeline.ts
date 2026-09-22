import type { AnswerProvider, DiagnosticsCallback, Evidence, Turn } from "../types.ts";
import type { KnowledgeRepository } from "../knowledge/repository.ts";
import type { JevJudge } from "../ai/jev.ts";
import { buildAnswerPlan, checkCompact, minimalHistory, normalizeCandidateEvidence, parseCompact, unknownEvidenceIds,
  type CompactCandidate, type CompactInput } from "./compact.ts";
import { asksForName } from "./conversation.ts";
import { measureText } from "./length-policy.ts";
import { asksForOrigin, evaluatedAxes, jevScopeDecision, jevVerdict, scopeDirective, softenForLowConfidence,
  type JevScopeDecision, type JevSettings } from "./jev-settings.ts";
import * as knowledgeText from "../knowledge/text.ts";
import type { JevScopeAspect } from "../ai/jev-scope.ts";
import type { ParsedAnswer } from "../ai/jev-primitives.ts";

export type JevPipeline = { judge: JevJudge; timeoutMs: number; settings: JevSettings; initialStagesUsed?: number };
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
  no_unnecessary_abstention: "資料で答えられる事実はそのまま残し、不明な部分だけを短く限定してください。答え全体を不明にしないでください。答えられる内容を冒頭に置き、不明・未確認の説明は全体で一文だけにしてください。質問が求めている項目に直接関わる事実と、背景として関わる事実だけを使ってください。関係の薄い別の話や逸話で答えを埋めないでください。背景の説明を、質問への直接の答えとして書き換えないでください。対象や時期を特定できず答えを決められないときは、渡した資料にある範囲で確認を促すだけにしてください。記録に無い因果は足さないでください。",
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
  // 生成へ渡す最終の根拠集合（探索で足した分を含む）を一度だけ知らせる。音声の最終source_set用。
  onEvidence?: (evidence: Evidence[]) => void;
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
  constructor(max: number, initial = 0) { this.max = max; this.used = Math.max(0, Math.min(max, Math.ceil(initial))); }
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

// 外へ送る前に確認できる根拠の件数。分割すると同じsnapshotで確認できないため、この数を超える集合は送らない。
const maxRevalidatedEvidence = 32;

// 外へ送る前に、持っている根拠が公開状態のままか確認する。
// 契約の上限を超える集合は切り詰めず、送らずに失敗させる（撤回済みの根拠を外へ出さない）。
async function revalidateEvidence(repository: KnowledgeRepository, evidence: Evidence[]): Promise<boolean> {
  if (!evidence.length || evidence.length > maxRevalidatedEvidence) return false;
  return repository.revalidateSnapshot(evidence);
}

// 元の検索結果と探索で足した根拠を、IDの重複だけを除いて1つの集合へまとめる。
// 元の根拠（事実・条件）も、足した根拠も落とさない。件数は探索の回数で決まるため、ここでは切らない。
export function mergeEvidence(existing: Evidence[], additions: Evidence[]): { evidence: Evidence[]; added: number } {
  const merged = new Map(existing.map(item => [item.id, item]));
  let added = 0;
  for (const item of additions) if (!merged.has(item.id)) { merged.set(item.id, item); added += 1; }
  return { evidence: [...merged.values()], added };
}

// 選別が選んだ主根拠の見出し。探索のクエリとルートの作り分けにだけ使い、事実としては使わない。
function evidenceTitle(evidence: Evidence[], id: string | null): string | undefined {
  return id === null ? undefined : evidence.find(item => item.id === id)?.title;
}

// 質問が求めている項目ごとの、探索へ足す辞書の語。選別が選んだ項目（requestedAspect）で引く。
// 項目の判定は選別に任せ、ここでは検索語を足すだけにする。答えられるかの判定には使わない。
const aspectSearchTerms: Record<JevScopeAspect, string> = {
  fact: "経歴 時期 担当 学歴 職歴",
  role: "役割 担当 立場",
  result: "成果 結果 実績",
  origin: "きっかけ 由来 理由 原因",
  value: "価値観 大切にしていること",
  example: "具体的な例 場面",
  general: ""
};

// 探索のクエリ。元の質問・利用者の発言・選んだ主根拠の見出し・求める項目の辞書語だけで作る。
// 履歴のAI発言や主観の文を、根拠の代わりに検索語へ混ぜない。
function expansionQuery(input: { question: string; history: Turn[] }, primaryTitle?: string, aspect?: JevScopeAspect): string {
  const user = minimalHistory(input.history).filter(turn => turn.role === "user").map(turn => turn.content);
  const aspects = aspect ? aspectSearchTerms[aspect] : "";
  return [input.question, ...user, ...(primaryTitle ? [primaryTitle] : []), aspects]
    .filter(Boolean).join("\n").slice(0, 4_000);
}

// 不足するルートだけを、質問と選んだ主根拠からコードで組み立てたクエリで広げる。
async function expandRoute(route: AnswerRoute, input: CompactInput, deps: VerifiedDeps, signal: AbortSignal,
  primaryTitle?: string, aspect?: JevScopeAspect) {
  if (!deps.search) return { route, added: 0 };
  const known = new Set(route.evidence.map(item => item.id));
  const started = performance.now();
  const found = (await deps.search(expansionQuery(input, primaryTitle, aspect), signal)).filter(item => !known.has(item.id)).slice(0, 2);
  if (!found.length) return { route, added: 0 };
  deps.diagnostics?.({ code: "beam_expanded", count: found.length, latencyMs: Math.round(performance.now() - started),
    ids: found.map(item => item.id) });
  // 見つけた根拠を上限で切り落とさない。元のルートの根拠と重複する分だけを除いて足す。
  const evidence = [...new Map([...route.evidence, ...found].map(item => [item.id, item])).values()];
  return { route: { ...route, evidence }, added: found.length };
}

// ビーム探索の本体。ルートを評価して、不足するルートを追加検索で広げる。
// 返すのは「元の検索に無かった根拠」だけ。回答の作り方（選別・生成・点検）は現行の経路のまま使う。
// 探索で狭いルートへ絞ると、答えられる根拠を失って最終点検で落ちるため、成果は足す方向にだけ使う。
async function exploreRoutes(input: CompactInput, deps: VerifiedDeps, history: CompactInput["history"],
  budget: StageLedger, signal: AbortSignal, primaryTitle?: string, aspect?: JevScopeAspect): Promise<Evidence[] | undefined> {
  const settings = deps.jev.settings, beam = settings.beam;
  if (!beam.enabled) { deps.diagnostics?.({ code: "beam_skipped", count: 1, reason: "disabled" }); return undefined; }
  if (!deps.jev.judge.checkRoutes) { deps.diagnostics?.({ code: "beam_skipped", count: 1, reason: "judge_unsupported" }); return undefined; }
  // この問いで使う段階は、選別1・探索の巡・（根拠が増えたときの）選び直し1・最終点検1・修復。
  // 選別と最終生成の後に残る段階だけを探索に使う。段階が足りないときは巡を減らし、修復は削らない。
  const rounds = Math.max(0, Math.min(beam.maxRounds, settings.limits.maxSerialStages - 3 - settings.limits.maxRepairs));
  if (!rounds) { deps.diagnostics?.({ code: "beam_skipped", count: 1, reason: "stage_limit" }); return undefined; }
  // 選別が選んだ主根拠の語も、ルートの作り分けに使う（決めた範囲を検索の選び方へ反映する）。
  const terms = [...knowledgeText.searchTerms(input.question), ...(primaryTitle ? knowledgeText.searchTerms(primaryTitle) : [])];
  let routes = initialRoutes(input.evidence, beam.candidatesPerRound, terms);
  if (routes.length < 2) { deps.diagnostics?.({ code: "beam_skipped", count: 1, reason: "routes_insufficient" }); return undefined; }
  const started = performance.now();
  // 最終生成と点検の時間を先に確保する。探索は自分の予算と段階の残りの中だけで行う。
  const exploreUntil = Math.min(started + beam.explorationMs, deps.deadline - settings.budgets.jevMs - 2_000);
  const additions = new Map<string, Evidence>();
  for (let round = 1; round <= rounds; round++) {
    if (performance.now() >= exploreUntil) { deps.diagnostics?.({ code: "beam_skipped", count: 1, reason: "time_insufficient" }); break; }
    if (!budget.spend(1)) { deps.diagnostics?.({ code: "beam_skipped", count: 1, reason: "stage_limit" }); break; }
    // ルートの評価も外への送信。送る前に、今持っている根拠が公開状態のままか確認する。
    const union = [...new Map(routes.flatMap(route => route.evidence).map(item => [item.id, item])).values()];
    if (!await revalidateEvidence(deps.repository, union)) throw new JevPipelineError("ANSWER_PROCESSING_FAILED");
    deps.diagnostics?.({ code: "beam_attempt", count: routes.length, reason: `round_${round}` });
    const roundStarted = performance.now();
    const assessment = await deps.jev.judge.checkRoutes({ question: input.question, history, routes }, signal);
    const scored = routes.map(route => ({ ...route, ...assessment.scores[route.id] }))
      .sort((left, right) => ((right.support ?? 0) + (right.target ?? 0)) - ((left.support ?? 0) + (left.target ?? 0)));
    deps.diagnostics?.({ code: "beam_complete", count: scored.length, reason: `round_${round}`,
      latencyMs: Math.round(performance.now() - roundStarted),
      scores: Object.fromEntries(scored.flatMap(route => [[`${route.id}.support`, Math.round((route.support ?? 0) * 100) / 100],
        [`${route.id}.target`, Math.round((route.target ?? 0) * 100) / 100]])) });
    routes = scored;
    const best = scored[0];
    if (best && routeSufficient(best, settings)) break;
    // 残したルートだけを追加検索で広げる。新しい根拠が増えなければ、同じ候補を回しているとみなして止める。
    // 最後の巡でも広げる。増えた根拠は選別のやり直しと生成へ渡し、同じ根拠でルート評価を重ねない。
    const expanded: AnswerRoute[] = [];
    let added = 0;
    for (const route of scored.slice(0, Math.max(1, beam.width))) {
      if (performance.now() >= exploreUntil) break;
      const result = await expandRoute(route, input, deps, signal, primaryTitle, aspect);
      expanded.push(result.route);
      added += result.added;
      // 元の検索に無い根拠だけを、生成へ足す候補として集める。
      for (const item of result.route.evidence) if (!input.evidence.some(current => current.id === item.id)) additions.set(item.id, item);
    }
    if (!added) break;
    routes = [...new Map(expanded.map(route => [route.id, route])).values()].slice(0, beam.candidatesPerRound);
    // この巡で広げた根拠は、次の巡を重ねずに選別のやり直しへ渡す。
    if (round >= rounds) break;
  }
  return additions.size ? [...additions.values()] : undefined;
}

// 選別の結果を、答え方の経路へ分ける。確信が低いときや矛盾があるときは、止めずに通常の生成へ回す。
// 生成しない経路（clarify・insufficient）は、エラーではなく確認と不足の案内を返す。
export type TriageRoute = "direct" | "partial" | "clarify" | "insufficient" | "unresolved";
export function triageRoute(decision: JevScopeDecision | undefined, settings: JevSettings,
  // 直前の会話を受ける質問かどうか。履歴があるときの指示語は、前段の選別が対象を決められないことがある。
  options: { followUp?: boolean; danglingReference?: boolean } = {}): TriageRoute {
  if (!decision) return "unresolved";
  // 履歴が無いのに直前の会話を指す質問は、対象を決められない。勝手に対象を選ばず、確認を返す。
  if (options.danglingReference) return "clarify";
  // 答えられる範囲が決まらず、使える支持も確認できていないときは、生成で埋め合わせずに案内へ回す。
  // 背景の支持でも足りる場合はこれまでどおり生成し、答えられる部分を失わない。
  // ただし、履歴を受ける指示語の質問は、検索と生成（どちらも履歴を使う）で指示語を解決させる。
  if (!options.followUp && !decision.contradiction && noUsableEvidence(decision, settings)) {
    if (decision.answerScope === "ambiguous") return "clarify";
    if (decision.answerScope === "insufficient") return "insufficient";
  }
  if (decision.lowConfidence || decision.contradiction) return "partial";
  if (decision.answerScope === "ambiguous") return "clarify";
  if (decision.answerScope === "answerable") return directRoute(decision, settings);
  if (decision.answerScope === "insufficient" && decision.primaryEvidenceId === null
    && decision.evidenceRole !== "direct" && decision.evidenceRole !== "background" && !decision.backgroundOnly)
    return "insufficient";
  return "partial";
}

// 直前の会話を指す言い方。履歴があるときだけ、指示語の解決を生成へ任せる。
const followUpReference = /(そこ|それ|その|あの|あれ|この|これ|同社|前述|前者|後者)/;
// 会話の流れが無いと対象が決まらない言い方。会場や会社を指す「この」「その」は含めない。
const danglingReference = /(そこ|それ|あの|あれ|前述|前者|後者)/;
export function refersToPrevious(question: string, history: readonly Turn[]): boolean {
  return history.length > 0 && followUpReference.test(question);
}
export function hasDanglingReference(question: string, history: readonly Turn[]): boolean {
  return history.length === 0 && danglingReference.test(question);
}

// 使える支持が確認できていない状態。直接の支持と背景の支持のどちらも無く、支持の強さも基準に届かない。
// 評価していない軸は「不足」とみなさず、生成して確かめる側へ倒す。
function noUsableEvidence(decision: JevScopeDecision, settings: JevSettings): boolean {
  if (decision.directSupported === true || decision.backgroundSupported === true) return false;
  if (decision.supportStrength !== undefined && decision.supportStrength < settings.scope.supportThreshold) return true;
  return decision.directSupported === false && decision.backgroundSupported === false;
}

// 直接の候補で探索を省けるか。答えられるという選択だけで決めず、直接支持の裏付け・役割・主根拠を確かめる。
// 裏付けが食い違うときは短絡せず、通常の生成と探索へ回す（選択と点数が食い違う回答を作らない）。
function directRoute(decision: JevScopeDecision, settings: JevSettings): TriageRoute {
  if (decision.needsSubjectClarification || decision.backgroundOnly || decision.offTopic) return "partial";
  const role = decision.evidenceRole;
  if (role !== undefined && role !== "direct" && role !== "mixed") return "partial";
  // 主根拠が候補集合に無いと、どの資料で答えるかを確かめられない。
  if (decision.primaryEvidenceId === null) return "unresolved";
  // 直接支持の軸が評価されていて満たしていないなら、選択と点数が食い違っている。
  if (directSupported(decision) === false) return "unresolved";
  // 支持の強さが評価されていて弱いなら、直接の答えとして扱わない。
  if (decision.supportStrength !== undefined && decision.supportStrength < settings.scope.supportThreshold) return "partial";
  return "direct";
}

// 直接支持の軸が評価されていれば、その判定を返す。評価されていなければundefined（不明）を返す。
function directSupported(decision: JevScopeDecision): boolean | undefined {
  const value = (decision as { directSupported?: unknown }).directSupported;
  return typeof value === "boolean" ? value : undefined;
}

// 生成を呼ばずに返す定型の候補。対象の確認か、資料に無いことの説明だけを返し、事実は足さない。
// 名前を尋ねる質問では、機械確認が認める定型文だけを使う。
export function fixedCandidate(kind: "clarify" | "insufficient", question: string): CompactCandidate {
  const name = asksForName(question);
  const text = kind === "clarify"
    ? (name ? "どの対象の名前を知りたいか教えてください。" : "どの対象・時期についてのお話か教えてください。")
    : (name ? "その名前は公開資料で確認できません。" : "その内容は公開資料では確認できていません。");
  return { text, answerability: "unknown", evidenceIds: [] };
}

// 定型の候補は作り直さない。見送った理由だけを残す。
function staticRepairReason(kind: "clarify" | "insufficient"): string {
  return kind === "clarify" ? "clarification_only" : "insufficient_evidence";
}

// 機械確認で落ちた理由を、原因を断定せず2つに分ける。IDの不備は根拠側、それ以外は形式側。
function mechanicalRejection(mechanical: string): "format" | "evidence_or_check" {
  return mechanical === "unknown_evidence" || mechanical === "missing_evidence_ids" ? "evidence_or_check" : "format";
}

// 失敗を、後から数えられる固定の理由へ分ける。
function failureReason(code: JevPipelineError["code"]): "rejected" | "held" | "timeout" | "unavailable" | "processing" {
  return code === "ANSWER_REJECTED" ? "rejected" : code === "ANSWER_HELD" ? "held"
    : code === "ANSWER_TIME_SHORT" ? "timeout" : code === "JEV_UNAVAILABLE" ? "unavailable" : "processing";
}

// 同じ材料で作り直して直せる軸。根拠に無い断定や、広げすぎた範囲・足した因果を削る直しに限る。
const repairableAxes = new Set<string>(["claims_supported", "no_scope_expansion", "no_invented_causality"]);
// 資料からは答えられないことを示す軸。この軸だけで落ちたときは、作り直さずに不足の案内へ落とす。
// 内容の裏付け・因果・範囲で落ちた場合は、資料に答えがある可能性があるため、資料に無いという案内に置き換えない。
const insufficientAxes = new Set<string>(["target_match", "aspect_match", "no_unnecessary_abstention"]);

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
// allowSecondStageは、低確信のときにもう一度聞き直すかどうか（探索後の選び直しでは1回だけ聞く）。
async function resolveAnswerScope(input: CompactInput, deps: VerifiedDeps, history: CompactInput["history"],
  budget: StageLedger, signal: AbortSignal, allowSecondStage = true): Promise<ScopeOutcome | undefined> {
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
    // 送る前に、今持っている根拠が公開状態のままか確認する（撤回済みは送らない）。
    if (!await revalidateEvidence(deps.repository, input.evidence)) throw new JevPipelineError("ANSWER_PROCESSING_FAILED");
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
      if (allowSecondStage && action === "second-stage" && budget.spend(2) && deps.deadline - performance.now() > settings.budgets.jevMs + 2_000) {
        decision = await ask(true); stages = 2;
        if (decision.lowConfidence) decision = softenForLowConfidence(decision);
      // allowSecondStageは2段目の呼び出しだけを止める。管理者の保留方針は、選び直しでも同じように守る。
      } else if (action === "hold") return { directive: scopeDirective(decision), decision, hold: true, stages };
      else if (action !== "proceed") decision = softenForLowConfidence(decision);
    }
    return { directive: scopeDirective(decision), decision, hold: false, stages };
  } catch (error) {
    signal.throwIfAborted();
    // 撤回の確認は回答を続けない（外へ送った後で気づくより、送る前に止める）。
    if (error instanceof JevPipelineError) throw error;
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
  const budget = new StageLedger(settings.limits.maxSerialStages, deps.jev.initialStagesUsed);
  const startedAt = performance.now();
  let accepted = false;
  let failure: "rejected" | "held" | "timeout" | "unavailable" | "processing" | undefined;
  try {
    const history = minimalHistory(input.history);
    // 直前の会話を受ける質問は、前段の選別が対象を決められなくても生成へ回す。
    const followUp = refersToPrevious(input.question, history);
    // 履歴が無いのに直前の会話を指す質問は、対象を選べないため確認を返す。
    const danglingReference = hasDanglingReference(input.question, history);
    const screened = await selectCandidates(input, deps, history, budget, signal);
    const scoped = screened === input.evidence ? input : { ...input, evidence: screened };
    // 先に選別（JEV①）を通し、答えられる範囲を決めてから、足りないときだけ探索する。
    let scope = await resolveAnswerScope(scoped, deps, history, budget, signal);
    if (scope?.hold) throw new JevPipelineError("ANSWER_HELD");
    let route = triageRoute(scope?.decision, settings, { followUp, danglingReference });
    deps.diagnostics?.({ code: "triage_route", count: 1, reason: route });
    let evidence = scoped.evidence;
    let addedCount = 0;
    let rescoped = false;
    if (route === "direct" || route === "clarify") {
      // 直接答えられる候補と、対象を確認する候補は、探索せずにそのまま進める。
      deps.diagnostics?.({ code: "beam_skipped", count: 1, reason: route === "direct" ? "direct_support" : "clarification" });
    } else {
      const primaryTitle = scope ? evidenceTitle(scoped.evidence, scope.decision.primaryEvidenceId) : undefined;
      const added = await exploreRoutes(scoped, deps, history, budget, signal, primaryTitle, scope?.decision.requestedAspect);
      if (added?.length) {
        const merged = mergeEvidence(evidence, added);
        addedCount = merged.added;
        evidence = merged.evidence;
        if (addedCount) deps.diagnostics?.({ code: "beam_merged", count: addedCount });
        // 新しい根拠が実際に増えたときだけ、増えた分を含む全候補でもう一度だけ選別する。
        // 最終生成と設定済みの修復の段を残せるときに限り、やり直す。
        if (addedCount && scope && budget.remaining >= 2 + settings.limits.maxRepairs) {
          const next = await resolveAnswerScope({ ...scoped, evidence }, deps, history, budget, signal, false);
          // 探索のあとの選び直しでも、管理者の保留方針は同じように効かせる。
          if (next?.hold) throw new JevPipelineError("ANSWER_HELD");
          if (next) { scope = next; rescoped = true; }
        }
      }
      route = triageRoute(scope?.decision, settings, { followUp, danglingReference });
    }
    // 対象が決まらないときと、使える根拠が無いまま探索を終えたときは、生成を呼ばずに定型の候補を出す。
    const fixedKind: "clarify" | "insufficient" | undefined = route === "clarify" ? "clarify"
      : route === "insufficient" && (addedCount === 0 || rescoped) ? "insufficient" : undefined;
    const plan = scope ? buildAnswerPlan(input.question, evidence, scope.decision) : undefined;
    const generationInput: CompactInput = { ...scoped, evidence, history, ...(plan ? { plan } : {}) };
    deps.onEvidence?.(generationInput.evidence);
    // 段階内で聞く軸は設定に従う。必須の軸は必ず含め、評価しない軸は採否に使わない。
    const evaluated = evaluatedAxes(settings);
    // 同じ材料での全文再生成は1回までにする。意味の不足は作り直しても直らないため、下の判定で作り直さない。
    const repairs = Math.max(0, Math.min(settings.limits.maxRepairs, 1, budget.remaining));
    let generationMs = 0, judgeMs = 0;
    const current = async () => {
      signal.throwIfAborted();
      // 探索で足した根拠も含めて、送信の直前に公開状態と本文を照合する。
      if (!await revalidateEvidence(deps.repository, generationInput.evidence)) throw new JevPipelineError("ANSWER_PROCESSING_FAILED");
      signal.throwIfAborted();
    };
    const judgeCandidate = async (candidate: CompactCandidate) => {
      await current();
      if (performance.now() >= deps.deadline) throw new JevPipelineError("ANSWER_TIME_SHORT");
      const judgeStarted = performance.now();
      deps.diagnostics?.({ code: "jev_attempt", count: evaluated.length });
      let assessment;
      for (let attempt = 0; ; attempt++) {
        try {
          // 点検へは、生成に渡した根拠（探索で足した分を含む）をそのまま渡す。
          assessment = await deps.jev.judge.check({ question: input.question, history, evidence: generationInput.evidence,
            candidate: candidate.text, axes: evaluated, asksForOrigin: asksForOrigin(input.question),
            ...(plan ? { answerPlan: plan, answerScope: plan.directive } : {}) }, signal);
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
      if (!decision.accepted) for (const axis of decision.failedAxes) deps.diagnostics?.({ code: "jev_rejected", count: 1, reason: axis });
      return decision;
    };
    // 定型の候補は生成も修復もしない。形式だけを機械で確認して、確認・不足の案内として返す。
    // 案内の本文はこちらが固定した1文で、事実も推測も述べない。答えるかどうかは前段の選別が決めており、
    // 同じ判定をもう一度かけると、案内そのものが棄権として落ちる（実APIの28問で定型は毎回全軸で不合格になった）。
    const fixedAnswer = async (kind: "clarify" | "insufficient"): Promise<CompactCandidate> => {
      const fixed = fixedCandidate(kind, input.question);
      const mechanical = checkCompact(fixed, generationInput);
      if (mechanical) {
        deps.diagnostics?.({ code: "candidate_rejected", count: 1, reason: mechanicalRejection(mechanical) });
        throw new JevPipelineError("ANSWER_REJECTED");
      }
      deps.diagnostics?.({ code: "repair_skipped", count: 1, reason: staticRepairReason(kind) });
      deps.diagnostics?.({ code: "answer_accepted", count: 1, reason: kind });
      accepted = true;
      return fixed;
    };
    if (fixedKind) return await fixedAnswer(fixedKind);
    let previous: CompactCandidate | undefined, repair: string | undefined;
    const failedAxes: string[] = [];
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
        // 非表示対象を推測で再生成しても点検AIへ送り直さず、回答全体を止める。
        if (deps.repository.exclusions?.matches(candidate.text)) throw new JevPipelineError("ANSWER_REJECTED");
        // 版のIDで引用された分は、渡した根拠へ寄せる（表記揺れを機械確認で落とさない）。
        const normalized = normalizeCandidateEvidence(candidate, generationInput.evidence);
        if (normalized.normalized.length) {
          deps.diagnostics?.({ code: "evidence_id_normalized", count: normalized.normalized.length, ids: normalized.normalized });
          candidate = normalized.candidate;
        }
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof JevPipelineError) throw error;
        if (error instanceof Error && error.message === "invalid_compact_payload" && !attempt) {
          repair = repairInstructions.invalid_compact_payload;
          continue;
        }
        throw new JevPipelineError("ANSWER_PROCESSING_FAILED");
      }
      let mechanical = checkCompact(candidate, generationInput);
      // 長さだけが理由で通らないときは、まず文の切れ目まで削って収める（内容は足さない）。
      // 削った本文も同じ最終点検へ通し、通らなければこれまでどおり修復へ進む。
      if (mechanical === "length_exceeded") {
        const trimmed = trimToBudget(candidate.text, generationInput.lengthBudget.max);
        if (trimmed) {
          const shortened = { ...candidate, text: trimmed };
          if (!checkCompact(shortened, generationInput)) {
            candidate = shortened;
            mechanical = null;
            deps.diagnostics?.({ code: "length_trimmed", count: 1, reason: attempt ? "final_attempt" : "first_attempt" });
          }
        }
      }
      if (mechanical) {
        const unknown = mechanical === "unknown_evidence" ? unknownEvidenceIds(candidate, generationInput.evidence) : [];
        deps.diagnostics?.({ code: "unsupported_claim", count: 1, reason: mechanical, ...(unknown.length ? { ids: unknown } : {}) });
        if (attempt >= repairs) {
          deps.diagnostics?.({ code: "candidate_rejected", count: 1, reason: mechanicalRejection(mechanical) });
          throw new JevPipelineError("ANSWER_REJECTED");
        }
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
      const decision = await judgeCandidate(candidate);
      if (decision.accepted) {
        await current();
        deps.diagnostics?.({ code: "answer_accepted", count: 1, reason: attempt ? "repaired" : "first_pass" });
        accepted = true;
        return candidate;
      }
      // 根拠に無い断定や広げすぎた範囲は、同じ材料で1回だけ削って作り直す。
      const repairable = decision.failedAxes.length > 0 && decision.failedAxes.every(axis => repairableAxes.has(axis));
      if (repairable && attempt < repairs) {
        previous = candidate; repair = decision.failedAxes.map(axis => repairInstructions[axis]).join("\n");
        continue;
      }
      // 対象・時期・答えられる範囲の不足は、同じ材料で全文を作り直しても直らない。作り直さずに終える。
      deps.diagnostics?.({ code: "candidate_rejected", count: 1, reason: "meaning_or_check" });
      if (!repairable) deps.diagnostics?.({ code: "repair_skipped", count: 1, reason: "not_answerable" });
      failedAxes.push(...decision.failedAxes);
      break;
    }
    // 資料からは答えられないという判定のときは、本文なしで終えず、資料に無いことの案内を返す。
    // 選別が「答えを含む」と判定していた質問では、資料に答えがある可能性があるため、案内に置き換えず却下する。
    const unanswered = scope?.decision.answerScope === "insufficient" || scope?.decision.answerScope === "ambiguous";
    if (failedAxes.length && (failedAxes.every(axis => insufficientAxes.has(axis)) || unanswered)) {
      return await fixedAnswer("insufficient");
    }
    throw new JevPipelineError("ANSWER_REJECTED");
  } catch (error) {
    if (error instanceof JevPipelineError) failure = failureReason(error.code);
    throw error;
  } finally {
    const latencyMs = Math.round(performance.now() - startedAt);
    if (accepted) deps.diagnostics?.({ code: "pipeline_complete", count: 1, latencyMs });
    else if (failure) deps.diagnostics?.({ code: "pipeline_failed", count: 1, reason: failure, latencyMs });
    // 実際に使ったJEVの段階数を残す（上限を超えていないことの確認に使う）。
    deps.diagnostics?.({ code: "stages_used", count: budget.count });
  }
}
