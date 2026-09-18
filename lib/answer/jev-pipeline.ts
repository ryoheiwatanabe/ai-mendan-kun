import type { AnswerProvider, DiagnosticsCallback, Evidence, Turn } from "../types.ts";
import type { KnowledgeRepository } from "../knowledge/repository.ts";
import type { JevJudge } from "../ai/jev.ts";
import { checkCompact, minimalHistory, parseCompact, type CompactCandidate, type CompactInput } from "./compact.ts";
import { jevScopeDecision, jevVerdict, scopeDirective, type JevSettings } from "./jev-settings.ts";

export type JevPipeline = { judge: JevJudge; timeoutMs: number; settings: JevSettings };
export class JevPipelineError extends Error {
  readonly code: "JEV_UNAVAILABLE" | "ANSWER_REJECTED" | "ANSWER_PROCESSING_FAILED" | "ANSWER_TIME_SHORT";
  constructor(code: "JEV_UNAVAILABLE" | "ANSWER_REJECTED" | "ANSWER_PROCESSING_FAILED" | "ANSWER_TIME_SHORT") {
    super(code); this.code = code;
  }
}
const repairInstructions: Record<string, string> = {
  target_match: "質問と履歴が指す人物・時期・会社・対象に合わせて答えてください。",
  aspect_match: "質問で求められた項目を答え、根拠が不足する部分だけを限定してください。",
  claims_supported: "根拠が支持しない主張を削り、資料から言える内容だけを残してください。",
  no_invented_causality: "資料に明記されていない因果や由来を削ってください。背景は背景として答え、由来は未確認と限定します。",
  no_scope_expansion: "数値・利益の帰属・担当範囲・時期・条件・否定を資料のまま保ってください。",
  no_unnecessary_abstention: "資料で答えられる部分を答え、不明な部分だけを限定してください。",
  length_exceeded: "lengthBudget.max以内に短くし、質問への答えと必要な限定を残してください。",
  unsupported_name: "名前は資料のnamesをそのまま返すか、名前を明記した原文だけを返してください。",
  unknown_evidence: "今回渡した根拠のIDだけを指定してください。",
  missing_evidence_ids: "回答を支える根拠のIDを付けてください。",
  invalid_compact_payload: "JSONを{text,answerability,evidenceIds}の形式に直してください。本文はtextに一度だけ書きます。"
};

type VerifiedDeps = { provider: AnswerProvider; repository: KnowledgeRepository;
  jev: JevPipeline; diagnostics?: DiagnosticsCallback; deadline: number };

// 生成前の選別は1段階だけ。残り時間に収まらないときは始めず、理由を残して生成へ進む。
async function resolveAnswerScope(input: CompactInput, deps: VerifiedDeps, history: Turn[], signal: AbortSignal): Promise<string | undefined> {
  if (!deps.jev.settings.scope.enabled) { deps.diagnostics?.({ code: "scope_skipped", count: 1, reason: "disabled" }); return undefined; }
  const judge = deps.jev.judge;
  if (!judge.checkScope) { deps.diagnostics?.({ code: "scope_skipped", count: 1, reason: "judge_unsupported" }); return undefined; }
  if (deps.deadline - performance.now() < deps.jev.settings.budgets.jevMs + 2_000) {
    deps.diagnostics?.({ code: "scope_skipped", count: 1, reason: "time_insufficient" }); return undefined;
  }
  const started = performance.now();
  deps.diagnostics?.({ code: "scope_attempt", count: 1 });
  try {
    const assessment = await judge.checkScope({ question: input.question, history, evidence: input.evidence }, signal);
    const decision = jevScopeDecision(input.question, assessment.scores, deps.jev.settings);
    deps.diagnostics?.({ code: "scope_complete", count: 1, latencyMs: Math.round(performance.now() - started),
      inputTokens: assessment.usage?.input, outputTokens: assessment.usage?.output, scopeScores: assessment.scores });
    return scopeDirective(decision);
  } catch (error) {
    signal.throwIfAborted();
    // 選別の失敗は回答を止めない。最終点検は別に必ず通す。
    deps.diagnostics?.({ code: "scope_error", count: 1, latencyMs: Math.round(performance.now() - started) });
    deps.diagnostics?.({ code: "scope_skipped", count: 1, reason: "scope_unavailable" });
    return undefined;
  }
}

// 1問につき生成2/JEV3（生成前1＋点検2）まで。旧LLM校閲は呼ばない。点検した本文をそのまま返す。
export async function verifiedCompactAnswer(input: CompactInput, deps: VerifiedDeps, signal: AbortSignal): Promise<CompactCandidate> {
  if (!deps.provider.generateCompact) throw new JevPipelineError("ANSWER_PROCESSING_FAILED");
  const history = minimalHistory(input.history);
  const scope = await resolveAnswerScope(input, deps, history, signal);
  const generationInput = { ...input, history, ...(scope ? { scope } : {}) };
  let previous: CompactCandidate | undefined, repair: string | undefined;
  let generationMs = 0;
  // 直前の点検にかかった実測時間。修復の見積もりに使う。
  let judgeMs = 0;
  const current = async () => {
    signal.throwIfAborted();
    if (!await deps.repository.revalidateSnapshot(input.evidence)) throw new JevPipelineError("ANSWER_PROCESSING_FAILED");
    signal.throwIfAborted();
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    // 修復は、直前の生成と点検に実際にかかった時間から見積もって、収まるときだけ始める。
    // 設定上の上限で見積もると、実際には収まる修復まで見送ってしまう。
    const reserve = attempt ? Math.round(generationMs * 1.2) + Math.max(Math.round(judgeMs), 500) + 500 : 0;
    if (performance.now() >= deps.deadline - reserve) {
      if (attempt) deps.diagnostics?.({ code: "repair_skipped", count: 1, reason: "time_insufficient" });
      throw new JevPipelineError(attempt ? "ANSWER_TIME_SHORT" : "ANSWER_PROCESSING_FAILED");
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
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && error.message === "invalid_compact_payload" && !attempt) {
        repair = repairInstructions.invalid_compact_payload;
        continue;
      }
      throw new JevPipelineError("ANSWER_PROCESSING_FAILED");
    }
    const mechanical = checkCompact(candidate, generationInput);
    if (mechanical) {
      deps.diagnostics?.({ code: "unsupported_claim", count: 1, reason: mechanical });
      if (attempt) throw new JevPipelineError("ANSWER_REJECTED");
      previous = candidate; repair = repairInstructions[mechanical] ?? repairInstructions.invalid_compact_payload;
      continue;
    }
    await current();
    if (performance.now() >= deps.deadline) throw new JevPipelineError("ANSWER_PROCESSING_FAILED");
    const judgeStarted = performance.now();
    deps.diagnostics?.({ code: "jev_attempt", count: 1 });
    let assessment;
    try {
      assessment = await deps.jev.judge.check({ question: input.question, history, evidence: input.evidence, candidate: candidate.text }, signal);
    } catch {
      signal.throwIfAborted();
      deps.diagnostics?.({ code: "jev_error", count: 1, latencyMs: Math.round(performance.now() - judgeStarted) });
      throw new JevPipelineError("JEV_UNAVAILABLE");
    }
    // 採点そのものと採否を分ける。採否は設定（閾値・必須/任意/記録のみ・任意の不合格件数）で決める。
    const decision = jevVerdict(assessment.scores, deps.jev.settings);
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
}
