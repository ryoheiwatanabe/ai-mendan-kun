import type { AnswerProvider, Answerability, ChatEvent, ChatRequest, EmbeddingProvider, Evidence, ModelPayload, SourceVersion, VectorIndex, DiagnosticsCallback, DiagnosticCode, LengthBudget, Turn } from "../types.ts";
import { KnowledgeRepository } from "../knowledge/repository.ts";
import { retrieve, expandRetrievalQuery } from "../knowledge/retrieval.ts";
import { asksForDecision, asksForPrivateDisclosure, isInjection } from "../security/request.ts";
import { looksLikeQuestion, validateSegment, parsePayload, parseSegment } from "./guard.ts";
import { conversationReply, asksForName, asksForSubjectFollowUp } from "./conversation.ts";
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

// 修復生成の指示。内部の判定コードをそのまま渡すと何を直すのか伝わらないため、
// 機械確認を通らなかった理由を、直すべき点として日本語で伝える。
const repairReasons: Record<string, string> = {
  length_exceeded: "前回の候補は長さの上限を超えていました。根拠は同じままで、質問への結論を冒頭の1文に置き、lengthBudget.max以内へ短くしてください。",
  unsupported_fact: "kindがfactの段落が、根拠の原文と一字も一致していません。根拠本文にある段落をそのまま使うか、grounded_synthesisへ切り替えて短く言い換えてください。",
  quote_not_found: "supportsのquoteが根拠本文に見つかりません。根拠本文の並びをそのまま切り出して引用し直してください。",
  claim_coverage: "claim.textを出現順に完全結合した結果がsegment.textと一致していません。表示する文をそのままの順でclaimsへ入れ、句読点も変えないでください。",
  claim_number_unsupported: "claim.textにある数値に対応する引用がsupportsにありません。その数値を含む箇所をquoteし直すか、根拠にその数値が無い場合は数値を落とした主張へ直してください。",
  missing_claims: "grounded_synthesisとinterpretationにはclaimsが必要です。表示する文をそのままclaimsへ入れてください。",
  invalid_limitation: "kindがlimitationのclaimは不足の説明だけに使えます。事実を述べる文はkindをstatementにしてsupportsを付けてください。",
  invalid_support: "supportsのevidenceIdとquoteの形式が不正です。今回のevidenceのidとその本文の引用だけを使ってください。",
  support_not_declared: "claimのsupportsにあるevidenceIdを、同じsegmentのevidenceIdsへ入れてください。",
  unknown_evidence: "evidenceIdsに今回渡していないidがあります。今回のevidenceにあるidだけを使ってください。",
  no_backed_claim: "supportsを持つstatementのclaimが1つもありません。根拠で支えられる文をstatementとして返してください。",
  empty_segments: "segmentsが空でした。根拠から答えられる範囲を、質問に直接答える形で返してください。"
  , conversation_not_allowed: "入力は本人について尋ねる質問です。挨拶や相槌の応答で置き換えず、根拠から答え、足りない部分はpartialとして残してください。",
  conversational_claim: "会話の応答に数値・固有名詞・本人の事実を入れられません。短い挨拶や受け止めの言葉だけにするか、根拠に基づく回答へ切り替えてください。",
    conversation_mixed: "会話の応答と根拠に基づく回答を同じ回答へ混ぜられません。どちらか一方にしてください。"
  , conversation_evidence: "会話の応答にevidenceIdsを付けられません。空配列にし、根拠が要る内容なら他のkindで答えてください。"
  // ここから下は segment の形そのものが不正なときの指示。理由名だけでは伝わらないため具体的に書く。
  , invalid_text: "segmentの本文が空です。質問へ答える文を入れてください。"
  , text_too_long: "segmentの本文が長すぎます。1200字以内に分けてください。"
  , invalid_evidence_ids: "evidenceIdsが不正です。配列にして、今回のevidenceのidだけを文字列で入れてください。"
  , missing_evidence_ids: "evidenceIdsが空です。根拠に基づく回答では、今回のevidenceのidを1〜6件入れてください。"
  , too_many_evidence_ids: "evidenceIdsが多すぎます。1つのsegmentへ入れるidは6件までにしてください。"
  , conversation_too_long: "会話の応答が長すぎます。120字以内の短い受け答えにしてください。"
  , invalid_supports: "supportsの形式が不正です。supportsは配列にし、各要素にevidenceIdとquoteの2つだけを入れてください。"
  , missing_supports: "supportsがありません。事実を述べるclaimには、その文を支える引用を1件以上付けてください。"
  , invalid_claim: "claimの形が不正です。text・kind・supportsの3つだけを入れ、kindはstatementかlimitationにしてください。"
  , too_many_claims: "claimが多すぎます。1つのsegmentのclaimsは8件までにまとめてください。"
  , empty_text: "本文が空です。質問へ答える文を入れてください。"
  , invalid_kind: "kindが不正です。fact・name・grounded_synthesis・interpretation・conversationalのいずれかにしてください。"
  , interpretation_not_requested: "interpretationは適性や仮定の相談のときだけ使えます。事実を述べる場合はgrounded_synthesisへ変えてください。"
  , unsupported_name: "記録に無い名前です。evidenceのnamesにある値だけを、そのまま使ってください。"
  , unknown_segments: "answerabilityがunknownのときはsegmentsを空にし、答えられる場合だけ文を入れてください。"
};
const repairFallback = "前回の候補は機械確認を通りませんでした。表示する文とclaimsの対応を根拠の範囲で確認し、同じ質問へ答える候補を作り直してください。";

export function repairInstruction(reason: string): string {
  return repairReasons[reason] ?? repairFallback;
}

// 校閲が却下した理由を、直すべき点として伝える。理由が無いときは従来の定型へ戻す。
const verifierRepairReasons: Record<string, string> = {
  unsupported_claim: "校閲で、根拠が支持しない主張があると判定されました。引用の範囲に収まる文だけを残し、支持できない内容は削ってください。",
  conflicting_facts: "校閲で、根拠どうしが矛盾すると判定されました。矛盾する記録を並べず、時点と主体が同じ記録だけで答えてください。",
  not_answering: "校閲で、質問が求めた項目に答えていないと判定されました。同じ時期というだけの別のエピソードで置き換えず、求めた項目（苦労・失敗・学びなど）を支える根拠だけを使って答え直してください。支える根拠が無い場合はpartial/unknownとして不足だけを短く示します。",
  unclear_inference: "校閲で、記録が明示していない推論だと判定されました。因果や効果の結び付けを外し、記録にある事実と不足の説明だけにしてください。",
  length_exceeded: repairReasons.length_exceeded,
};

export function verifierRepairInstruction(reason: string | undefined): string {
  return verifierRepairReasons[reason ?? ""]
    ?? "校閲で却下されました。根拠の主体・時点・否定・条件と質問への直接性を確認し、支持できない主張を修正してください。";
}

export async function* answer(input: ChatRequest, deps: {
  repository: KnowledgeRepository; vector: VectorIndex; embedding: EmbeddingProvider; provider: AnswerProvider;
  onEvidence?: (evidence: Evidence[], sourceSet?: SourceVersion[]) => void;
  diagnostics?: DiagnosticsCallback;
  careerOverview?: string;
  // 追加の生成・校閲を打ち切るまでの時間。テストから短く指定できる。
  timeBudgetMs?: number;
}, signal: AbortSignal): AsyncGenerator<ChatEvent> {
  const start = performance.now();
  const answerId = crypto.randomUUID();
  let first: number | null = null, similarity: number | null = null;
  const budget = lengthPolicy(input.message);
  const diag = (code: DiagnosticCode, extra: { count?: number; latencyMs?: number; inputTokens?: number; outputTokens?: number; reason?: string; ids?: string[] } = {}) =>
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
    // 報酬・私生活・未公開資料は定型でお断りする。生成の判断に委ねない。
    if (asksForPrivateDisclosure(input.message)) {
      for (const event of emit(boundedStatic(budget, "年収や私生活、未公開の資料は、本人が公開を決めていないためこの場ではお答えしていません。必要な場合は面談で本人に確認してください。", "公開していない情報はお答えしていません。面談で本人に確認してください。"), "unknown")) { signal.throwIfAborted(); yield event; }
      return;
    }
    const conversational = conversationReply(input.message);
    if (conversational) {
      for (const event of emit(boundedStatic(budget, conversational, tinyUnknown), "answerable")) { signal.throwIfAborted(); yield event; }
      return;
    }
    // 履歴が無く、対象を省いた追質問だけの場合は、対象を一つ確認する。
    if (!input.history.length && asksForSubjectFollowUp(input.message)) {
      for (const event of emit(boundedStatic(budget, ambiguous, tinyUnknown), "ambiguous")) { signal.throwIfAborted(); yield event; }
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
    // 取得候補と採用候補の件数だけを残す。識別子は再現条件用に付けるが、
    // 通常のログへは出さず（diagnostics.tsが落とす）、DEBUG_TRACEのときだけ外へ出す。
    diag("candidates_retrieved", { count: result.retrieved ?? result.evidence.length });
    diag("candidates_adopted", { count: result.evidence.length, ids: result.evidence.map(item => item.id) });
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
      // 根拠が無く、質問形でもない短い発話（挨拶・相槌・聞き取りの崩れ）は、
      // LLMに会話として応じさせる。生成が会話応答を返せなければ従来どおり不明を返す。
      if (!looksLikeQuestion(input.message)) {
        const conversational = await generate({ diag: diagnostic => deps.diagnostics?.(diagnostic), provider: deps.provider,
          question: input.message, history: input.history, evidence: [], highRisk: false, budget, signal });
        signal.throwIfAborted();
        if (conversational.segments.length
          && validateCandidate(conversational, evidence, true, input.message, budget).ok) {
          diag("conversation_reply", { count: 1 });
          for (const event of emit(renderCandidate(conversational), conversational.answerability)) { signal.throwIfAborted(); yield event; }
          return;
        }
      }
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
    // 応答全体の時間予算。経路の上限（route側90秒）より手前で打ち切り、
    // 途中でabortされてエラーになる代わりに、得られている範囲で静かに終える。
    const deadline = performance.now() + (deps.timeBudgetMs ?? 78_000);
    let timeExhausted = false;
    const outOfTime = () => {
      if (performance.now() <= deadline) return false;
      timeExhausted = true;
      return true;
    };

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

    // 再検索は、回答が実質的に「根拠が無い」だけのときに限る（予算1回）。
    // 実質的な回答に足された不足の説明（limitationが一部にある）では再検索しない。
    // 再検索は生成がもう1回増えて数秒〜十数秒かかるため、届いている根拠を捨てない範囲に留める。
    const missingGrounds = candidate.segments.length > 0 && candidate.segments.every(segment =>
      segment.kind === "grounded_synthesis" && segment.claims.every(claim => claim.kind === "limitation"));
    if ((!candidate.segments.length || missingGrounds) && retries === 0 && !outOfTime()) {
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
      if (timeExhausted) diag("time_budget_exhausted", { count: 1 });
      const isAmbiguous = candidate.answerability === "ambiguous";
      const text = isAmbiguous ? ambiguous : unknown;
      for (const event of emit(boundedStatic(budget, text, tinyUnknown), isAmbiguous ? "ambiguous" : "unknown")) { signal.throwIfAborted(); yield event; }
      return;
    }

    // 増分セグメント出力の canonical 表現を蓄積し、最終 payload と厳密に照合する。
    // 完了 payload は一度だけ parsePayload で解析する。
    let verified = false;
    let lastFailure: DiagnosticCode = "verification_error";
    // 校閲が却下した理由。修復指示を具体的にするために保持する。
    let verifierDetail: string | undefined;
    // 会話応答を根拠ある回答の代わりに使おうとした場合、処理失敗ではなく不明として返す。
    let lastName = "";
    // 会話応答を根拠ある回答の代わりに使おうとしたかどうか。
    let conversationalAttempt = false;
    while (verifications < 2) {
      if (!await deps.repository.revalidate(evidence)) {
        signal.throwIfAborted();
        diag("stale_or_revoked", { count: 1 });
        throw new StaleEvidenceError();
      }
      signal.throwIfAborted();
      const check = validateCandidate(candidate, evidence, allowInterpretation, input.message, budget);
      conversationalAttempt ||= candidate.segments.some(segment => segment.kind === "conversational");
      if (check.ok) {
        // 根拠を要さない会話応答はclaimsを持たないため、校閲を省いて即返す。
        if (candidate.segments.every(segment => segment.kind === "conversational")) {
          diag("conversation_reply", { count: 1 });
          verified = true; break;
        }
        if (outOfTime()) break;
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
        verifierDetail = verifiedResult.detail;
        diag(lastFailure, { count: 1, reason: verifiedResult.detail });
      } else {
        lastFailure = check.reason === "length_exceeded" ? "length_exceeded" : "unsupported_claim";
        lastName = check.reason;
        // 落ちた理由（quote_not_foundなど）は固定識別子なので、原因特定のためだけに残す。
        diag(lastFailure, { count: 1, reason: check.reason });
      }
      // 修復生成は最大1回。生成回数は2で打ち切り。
      if (generations >= 2 || outOfTime()) break;
      diag("repair_attempted", { count: 1 });
      try {
        const repaired = await generateOnce(check.ok ? verifierRepairInstruction(verifierDetail) : repairInstruction(check.reason), candidate);
        signal.throwIfAborted();
        if (repaired.segments.length) { candidate = repaired; state = repaired.answerability; }
        else {
          // 修復生成の棄権も初回の棄権と同じ定型へ戻す。断念を処理失敗として返さない。
          diag("model_abstained", { count: 1 });
          const isAmbiguous = repaired.answerability === "ambiguous";
          for (const event of emit(boundedStatic(budget, isAmbiguous ? ambiguous : unknown, tinyUnknown), isAmbiguous ? "ambiguous" : "unknown")) { signal.throwIfAborted(); yield event; }
          return;
        }
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
      // 時間予算で打ち切った場合は、その理由を残す。エラーへは変えない。
      if (timeExhausted) diag("time_budget_exhausted", { count: 1 });
      // 長さだけが理由で通らない場合は、上限に収まる段落まで削って返す。答えられるのに不明へ落とさない。
      if (lastFailure === "length_exceeded" && candidate.segments.length > 1) {
        const kept: typeof candidate.segments = [];
        for (const segment of candidate.segments) {
          const next = { ...candidate, segments: [...kept, segment], answerability: "partial" as const };
          if (!withinBudget(renderCandidate(next), budget)) break;
          if (!validateCandidate(next, evidence, allowInterpretation, input.message, budget).ok) break;
          kept.push(segment);
        }
        if (kept.length) {
          const trimmed: ModelPayload = { ...candidate, segments: kept, answerability: "partial" };
          const checked = await verify({ provider: deps.provider, question: input.message, history: input.history,
            evidence, candidate: trimmed, lengthBudget: budget, highRisk: risky }, signal);
          signal.throwIfAborted();
          if (checked.ok) {
            diag("length_trimmed", { count: kept.length });
            for (const event of emit(renderCandidate(trimmed), "partial")) { signal.throwIfAborted(); yield event; }
            return;
          }
        }
      }
      // 機械確認を通る候補を作れなかった場合は、処理失敗の案内ではなく、断定できない旨を返す。
      // 会話応答で質問を置き換えようとした場合も同じ扱いにする。
      for (const event of emit(boundedStatic(budget, unknown, tinyUnknown), "unknown")) { signal.throwIfAborted(); yield event; }
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
  if (segment.kind === "fact" || segment.kind === "name" || segment.kind === "conversational") return { kind: segment.kind, text: segment.text, evidenceIds: [...segment.evidenceIds] };
  return { kind: segment.kind, text: segment.text, evidenceIds: [...segment.evidenceIds],
    claims: segment.claims.map(claim => ({ text: claim.text, kind: claim.kind, supports: claim.supports.map(support => ({ evidenceId: support.evidenceId, quote: support.quote })) })) };
}

// 候補の機械検証。fact/nameは原文一致、grounded_synthesis/interpretationはclaims。
function validateCandidate(candidate: ModelPayload, evidence: Evidence[], allowInterpretation: boolean, question: string, budget: LengthBudget):
  { ok: true } | { ok: false; reason: string } {
  if (!candidate.segments.length) return { ok: false, reason: "empty_segments" };
  // 会話応答は単独のときだけ認める。根拠に基づく回答と混ぜない。
  const kinds = new Set(candidate.segments.map(segment => segment.kind));
  if (kinds.has("conversational") && kinds.size > 1) return { ok: false, reason: "conversation_mixed" };
  // 会話応答は「答えられなかった」わけではないため、unknownでも中身を返してよい。
  if (candidate.answerability === "unknown" && !kinds.has("conversational")) return { ok: false, reason: "unknown_segments" };
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
