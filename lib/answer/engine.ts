import type { AnswerProvider, Answerability, ChatEvent, ChatRequest, EmbeddingProvider, Evidence, ModelPayload, SourceVersion, VectorIndex, DiagnosticsCallback, DiagnosticCode, LengthBudget, Turn } from "../types.ts";
import { KnowledgeRepository } from "../knowledge/repository.ts";
import { retrieve, expandRetrievalQuery } from "../knowledge/retrieval.ts";
import { asksForDecision, isInjection } from "../security/request.ts";
import { validateSegment, parsePayload, parseSegment } from "./guard.ts";
import { conversationReply, asksForName } from "./conversation.ts";
import { asksForCareerOverview, loadCareerOverview } from "./overview.ts";
import { lengthPolicy, measureText, withinBudget } from "./length-policy.ts";
import { verify } from "./verifier.ts";

const processingFailure = "処理に失敗しました。時間をおいてもう一度お試しください。";
const processingFailureShort = "処理に失敗しました。";
const unknown = "その点はまだ確認できていません。面談で本人に聞いてみてください。";
const ambiguous = "どの時期・プロジェクトについて知りたいか、もう少し詳しく教えてください。";
const tinyUnknown = "確認が必要です。";
const tinyUnknownShort = "未確認";
const staticFallback = "？";

// 予算内で完結する定型を [preferred, fallback, "未確認", "？"] の順で選ぶ。切片処理はしない。
function boundedStatic(budget: LengthBudget, preferred: string, fallback: string): string {
  const list = [preferred, fallback, tinyUnknownShort, staticFallback];
  return list.find(value => withinBudget(value, budget)) ?? staticFallback;
}

// 撤回・失効は固定の private exception に写像する。修復は試みない。
class StaleEvidenceError extends Error {
  constructor() {
    super("stale_evidence");
    this.name = "StaleEvidenceError";
  }
}

export async function* answer(input: ChatRequest, deps: {
  repository: KnowledgeRepository; vector: VectorIndex; embedding: EmbeddingProvider; provider: AnswerProvider;
  onEvidence?: (evidence: Evidence[], sourceSet?: SourceVersion[]) => void;
  diagnostics?: DiagnosticsCallback;
  careerOverview?: string;
}, signal: AbortSignal): AsyncGenerator<ChatEvent> {
  const start = performance.now();
  const answerId = crypto.randomUUID();
  let first: number | null = null, similarity: number | null = null;
  const budget = lengthPolicy(input.message);
  const diag = (code: DiagnosticCode, extra: { count?: number; latencyMs?: number; inputTokens?: number; outputTokens?: number } = {}) =>
    deps.diagnostics?.({ code, ...extra });

  const done = (answerability: Answerability): ChatEvent => {
    signal.throwIfAborted();
    return { type: "done", answerId, answerability,
      latencyMs: Math.round(performance.now() - start), firstTextMs: first === null ? null : Math.round(first),
      retrievalSimilarityPercent: (answerability === "answerable" || answerability === "partial") && similarity !== null ? Math.round(similarity * 100) : null };
  };

  // 検証済み最終文字列のみを一度に送出する。
  const emit = (text: string, answerability: Answerability): ChatEvent[] => {
    signal.throwIfAborted();
    first = performance.now() - start;
    return [{ type: "text", text, answerId }, done(answerability)];
  };

  yield { type: "start", answerId };
  signal.throwIfAborted();

  try {
    if (isInjection(input.message)) {
      for (const event of emit(boundedStatic(budget, "本人が公開用に承認した経験や考え方についてお答えします。気になる仕事や経験を、具体的に聞いてみてください。", tinyUnknown), "unknown")) { signal.throwIfAborted(); yield event; }
      return;
    }
    if (asksForDecision(input.message)) {
      for (const event of emit(boundedStatic(budget, "参加や入社、契約条件への承諾は本人が判断します。このAIでは確約できないため、面談で本人に確認してください。", tinyUnknown), "unknown")) { signal.throwIfAborted(); yield event; }
      return;
    }
    const conversational = conversationReply(input.message);
    if (conversational) {
      for (const event of emit(boundedStatic(budget, conversational, tinyUnknown), "answerable")) { signal.throwIfAborted(); yield event; }
      return;
    }
    if (asksForCareerOverview(input.message)) {
      const overview = await loadCareerOverview(deps.careerOverview, deps.repository, budget);
      signal.throwIfAborted();
      if (overview) {
        deps.onEvidence?.(overview.evidence, overview.sourceSet);
        for (const event of emit(overview.text, "answerable")) { signal.throwIfAborted(); yield event; }
        return;
      }
    }

    const result = await retrieve({ question: input.message, history: input.history, ...deps, signal });
    signal.throwIfAborted();
    deps.onEvidence?.(result.evidence);
    if (result.conflicts.length) {
      diag("conflicting_facts", { count: result.conflicts.length });
      for (const event of emit(boundedStatic(budget, "この点は、公開用の記録に一致しない情報があるため断定できません。正確な内容は本人に確認してください。", tinyUnknown), "ambiguous")) { signal.throwIfAborted(); yield event; }
      return;
    }

    // 無根拠は決定論的な同義語展開で1回だけ再検索する。模範回答を事実として混ぜない。
    // 初回のクエリを展開後クエリと比較し、同一なら再検索しない（重複リトライ回避）。
    let evidence = result.evidence;
    let similarityScores = result.similarityScores;
    let retries = 0;
    const expandedQuery = expandRetrievalQuery(input.message, input.history);
    if (!evidence.length) {
      diag("no_evidence", { count: 1 });
      if (expandedQuery !== input.message && expandedQuery !== result.query) {
        const retry = await retrieve({ question: input.message, history: input.history, ...deps, signal, retrievalQuery: expandedQuery });
        signal.throwIfAborted();
        retries = 1;
        diag("retrieval_retry", { count: 1 });
        deps.onEvidence?.(retry.evidence);
        if (retry.conflicts.length) {
          diag("conflicting_facts", { count: retry.conflicts.length });
          for (const event of emit(boundedStatic(budget, "この点は、公開用の記録に一致しない情報があるため断定できません。正確な内容は本人に確認してください。", tinyUnknown), "ambiguous")) { signal.throwIfAborted(); yield event; }
          return;
        }
        if (retry.evidence.length) { evidence = retry.evidence; similarityScores = retry.similarityScores; }
      }
    }
    if (!evidence.length) {
      for (const event of emit(boundedStatic(budget, unknown, tinyUnknown), "unknown")) { signal.throwIfAborted(); yield event; }
      return;
    }
    if (!await deps.repository.revalidate(evidence)) {
      signal.throwIfAborted();
      diag("stale_or_revoked", { count: 1 });
      throw new StaleEvidenceError();
    }
    signal.throwIfAborted();

    const risky = asksForName(input.message) || evidence.some(item => item.entities.length > 0);
    const allowInterpretation = true;

    let generations = 0;
    let verifications = 0;

    const generateOnce = async (repair?: string, previous?: ModelPayload): Promise<ModelPayload> => {
      if (generations >= 2) throw new Error("generation_limit");
      // 生成発行前に全根拠を再検証する。
      if (!await deps.repository.revalidate(evidence)) {
        signal.throwIfAborted();
        diag("stale_or_revoked", { count: 1 });
        throw new StaleEvidenceError();
      }
      signal.throwIfAborted();
      generations += 1;
      return generate({ diag: diagnostic => deps.diagnostics?.(diagnostic), provider: deps.provider, question: input.message, history: input.history,
        evidence, highRisk: risky, budget, repair, previous, signal });
    };

    let candidate = await generateOnce();
    signal.throwIfAborted();
    let state = candidate.answerability;

    // 空生成の再試行は、既存evidenceで拡張クエリ再検索してから第二生成を一度だけ。
    if (!candidate.segments.length && retries === 0) {
      if (expandedQuery !== input.message && expandedQuery !== result.query) {
        const retry = await retrieve({ question: input.message, history: input.history, ...deps, signal, retrievalQuery: expandedQuery });
        signal.throwIfAborted();
        retries = 1;
        diag("retrieval_retry", { count: 1 });
        deps.onEvidence?.(retry.evidence);
        if (retry.conflicts.length) {
          diag("conflicting_facts", { count: retry.conflicts.length });
          for (const event of emit(boundedStatic(budget, "この点は、公開用の記録に一致しない情報があるため断定できません。正確な内容は本人に確認してください。", tinyUnknown), "ambiguous")) { signal.throwIfAborted(); yield event; }
          return;
        }
        if (retry.evidence.length) {
          evidence = retry.evidence;
          similarityScores = retry.similarityScores;
          candidate = await generateOnce();
          signal.throwIfAborted();
          state = candidate.answerability;
        }
      }
    }

    if (!candidate.segments.length) {
      // モデルが明示的に棄権した場合は answerability に関わらず model_abstained を記録する。
      diag("model_abstained", { count: 1 });
      const isAmbiguous = candidate.answerability === "ambiguous";
      const text = isAmbiguous ? ambiguous : unknown;
      for (const event of emit(boundedStatic(budget, text, tinyUnknown), isAmbiguous ? "ambiguous" : "unknown")) { signal.throwIfAborted(); yield event; }
      return;
    }

    // 増分セグメント出力の canonical 表現を蓄積し、最終 payload と厳密に照合する。
    // 完了 payload は一度だけ parsePayload で解析する。
    let verified = false;
    let lastFailure: DiagnosticCode = "verification_error";
    while (verifications < 2) {
      if (!await deps.repository.revalidate(evidence)) {
        signal.throwIfAborted();
        diag("stale_or_revoked", { count: 1 });
        throw new StaleEvidenceError();
      }
      signal.throwIfAborted();
      const check = validateCandidate(candidate, evidence, allowInterpretation, input.message, budget);
      if (check.ok) {
        const verificationStarted = performance.now();
        const verifiedResult = await verify({ provider: deps.provider, question: input.message, history: input.history,
          evidence, candidate, lengthBudget: budget, highRisk: risky }, signal);
        signal.throwIfAborted();
        if (verifiedResult.usage) {
          verifications += 1;
          diag("verification_complete", { count: 1, latencyMs: Math.round(performance.now() - verificationStarted), inputTokens: verifiedResult.usage.input, outputTokens: verifiedResult.usage.output });
        } else {
          verifications += 1;
          diag("verification_complete", { count: 1, latencyMs: Math.round(performance.now() - verificationStarted) });
        }
        if (verifiedResult.ok) { verified = true; break; }
        lastFailure = verifiedResult.reason === "verifier_unavailable" ? "verification_error" : "verification_rejected";
        diag(lastFailure, { count: 1 });
      } else {
        lastFailure = check.reason === "length_exceeded" ? "length_exceeded" : "unsupported_claim";
        diag(lastFailure, { count: 1 });
      }
      // 修復生成は最大1回。生成回数は2で打ち切り。
      if (generations >= 2) break;
      diag("repair_attempted", { count: 1 });
      try {
        const repaired = await generateOnce(check.ok ? "校閲で却下されました。根拠の主体・時点・否定・条件と質問への直接性を確認し、支持できない主張を修正してください。" : check.reason, candidate);
        signal.throwIfAborted();
        if (repaired.segments.length) { candidate = repaired; state = repaired.answerability; }
        else { lastFailure = "verification_rejected"; break; }
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof StaleEvidenceError) throw error;
        diag("generation_error", { count: 1 });
        yield { type: "error", code: "processing_failure", message: boundedStatic(budget, processingFailureShort, "失敗") };
        return;
      }
    }

    if (!verified) {
      diag(lastFailure, { count: 1 });
      yield { type: "error", code: "processing_failure", message: boundedStatic(budget, processingFailureShort, "失敗") };
      return;
    }

    // 送出直前に全根拠を再照合する。
    if (!await deps.repository.revalidate(evidence)) {
      signal.throwIfAborted();
      diag("stale_or_revoked", { count: 1 });
      throw new StaleEvidenceError();
    }
    signal.throwIfAborted();

    const rendered = renderCandidate(candidate);
    if (!withinBudget(rendered, budget)) {
      diag("length_exceeded", { count: measureText(rendered) });
      yield { type: "error", code: "processing_failure", message: boundedStatic(budget, processingFailureShort, "失敗") };
      return;
    }

    if (candidate.segments.every(segment => segment.kind === "fact" || segment.kind === "name")) {
      for (const segment of candidate.segments) {
        const checked = validateSegment(segment, evidence, true, input.message);
        if (checked.ok) for (const id of checked.matchedEvidenceIds) {
          const score = similarityScores.get(id);
          if (score !== undefined) similarity = Math.max(similarity ?? 0, score);
        }
      }
    }
    if (state === "unknown" && candidate.segments.length) state = "answerable";
    for (const event of emit(rendered, state)) { signal.throwIfAborted(); yield event; }
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof StaleEvidenceError) {
      yield { type: "error", code: "processing_failure", message: boundedStatic(budget, processingFailureShort, "失敗") };
      return;
    }
    diag("generation_error", { count: 1 });
    yield { type: "error", code: "processing_failure", message: boundedStatic(budget, processingFailure, processingFailureShort) };
  }
}

// 生成: purpose=answerで1回。完了までバッファし、segmentsは呼び出し側で検証する。
// 各 yield 前に abort を確認する。完了 usage は resolvable な値を一度だけ返す。
async function generate(input: {
  provider: AnswerProvider; question: string; history: Turn[]; evidence: Evidence[];
  diag: DiagnosticsCallback; highRisk: boolean; budget: LengthBudget; repair?: string; previous?: ModelPayload; signal: AbortSignal;
}): Promise<ModelPayload> {
  const started = performance.now();
  let usage: { input: number; output: number } | undefined;
  let payload: ModelPayload | null = null;
  let seenComplete = false;
  let incremental: string[] = [];
  input.signal.throwIfAborted();
  for await (const output of input.provider.stream({
    question: input.question, history: input.history, evidence: input.evidence, highRisk: input.highRisk,
    purpose: "answer", repair: input.repair, candidate: input.previous, lengthBudget: input.budget
  }, input.signal)) {
    input.signal.throwIfAborted();
    if (output.type === "segment") {
      if (seenComplete) throw new Error("segment_after_complete");
      const parsed = parseSegment(output.segment);
      incremental.push(JSON.stringify(canonicalForCompare(parsed)));
    } else if (output.type === "complete") {
      if (seenComplete) throw new Error("duplicate_complete_record");
      seenComplete = true;
      usage = output.usage;
      payload = parsePayload(output.payload);
      const finalCanonical = payload.segments.map(segment => JSON.stringify(canonicalForCompare(segment)));
      if (finalCanonical.length !== incremental.length
        || finalCanonical.some((value, index) => value !== incremental[index])) throw new Error("segment_payload_mismatch");
    }
  }
  input.signal.throwIfAborted();
  if (!payload || !seenComplete) throw new Error("incomplete_answer");
  input.diag({ code: "generation_complete", count: 1, latencyMs: Math.round(performance.now() - started), ...(usage ? { inputTokens: usage.input, outputTokens: usage.output } : {}) });
  return payload;
}

function canonicalForCompare(segment: import("../types.ts").Segment): unknown {
  if (segment.kind === "fact" || segment.kind === "name") return { kind: segment.kind, text: segment.text, evidenceIds: [...segment.evidenceIds] };
  return { kind: segment.kind, text: segment.text, evidenceIds: [...segment.evidenceIds],
    claims: segment.claims.map(claim => ({ text: claim.text, kind: claim.kind, supports: claim.supports.map(support => ({ evidenceId: support.evidenceId, quote: support.quote })) })) };
}

// 候補の機械検証。fact/nameは原文一致、grounded_synthesis/interpretationはclaims。
function validateCandidate(candidate: ModelPayload, evidence: Evidence[], allowInterpretation: boolean, question: string, budget: LengthBudget):
  { ok: true } | { ok: false; reason: string } {
  if (!candidate.segments.length) return { ok: false, reason: "empty_segments" };
  if (candidate.answerability === "unknown") return { ok: false, reason: "unknown_segments" };
  const rendered = renderCandidate(candidate);
  if (!withinBudget(rendered, budget)) return { ok: false, reason: "length_exceeded" };
  for (const segment of candidate.segments) {
    const check = validateSegment(segment, evidence, allowInterpretation, question);
    if (!check.ok) return { ok: false, reason: check.reason };
  }
  return { ok: true };
}

// 最終表示文。name は常に segment.text を使い語尾のみを付す。fact は原文、合成/解釈は claim 本文を連結する。
function renderCandidate(candidate: ModelPayload): string {
  return candidate.segments.map(segment => {
    if (segment.kind === "name") return `${segment.text}です。`;
    return segment.text;
  }).join("\n\n");
}
