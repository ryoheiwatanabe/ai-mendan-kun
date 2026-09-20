export type ApprovalStatus = "draft" | "approved" | "superseded" | "rejected" | "revoked";
export type Visibility = "public" | "interview" | "private";
export type Answerability = "answerable" | "partial" | "unknown" | "ambiguous";
export type Turn = { role: "user" | "assistant"; content: string };
export type ChatRequest = { mode: "meeting_text"; message: string; history: Turn[]; speak?: boolean };
export interface Statement {
  bind(...values: unknown[]): Statement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}
export interface Database {
  prepare(sql: string): Statement;
  batch<T = Record<string, unknown>>(statements: Statement[]): Promise<{ results: T[] }[]>;
}
export interface VectorIndex {
  query(vector: number[], options: { topK: number; filter: Record<string, string>; returnMetadata: "none" }): Promise<{ matches: { id: string; score: number }[] }>;
}
// Workers AIの埋め込みだけを使う。外部APIキーを持たずにバインディングから呼ぶ。
export interface AiBinding {
  // 埋め込み（Workers AI）と、typesafe/jevのような判定モデルの両方に使う。
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}
export interface EmbeddingProvider { embed(text: string, signal?: AbortSignal, purpose?: "query" | "document"): Promise<number[]> }
export type Evidence = {
  id: string;
  revisionId: string;
  documentId: string;
  title: string;
  content: string;
  contentHash: string;
  entities: string[];
  excludedStatements?: string[];
  kind: "chunk" | "exact_fact";
  rank: number;
};
export type SourceVersion = { documentId: string; revisionId: string; contentHash: string };
export type Fact = {
  id: string;
  fact_key: string;
  fact_value: string;
  statement: string;
  aliases_json: string;
  revision_id: string;
  document_id: string;
  content_hash: string;
  valid_from: string | null;
  valid_to: string | null;
  supersedes_fact_id: string | null;
};

// 短い引用は意味の裏付けにならない。主張ごとに根拠IDと引用箇所を要求する。
export type ClaimSupport = { evidenceId: string; quote: string };
// limitation文はsupportsが空を許すが、verifierがmissing-info/needsDecisionと判断できる場合のみ。
export type Claim = { text: string; supports: ClaimSupport[]; kind?: "statement" | "limitation" };

// fact/nameは原文一致の機械照合。grounded_synthesis/interpretationはclaims経由。
export type Segment =
  | { kind: "fact"; text: string; evidenceIds: string[] }
  | { kind: "name"; text: string; evidenceIds: string[] }
  | { kind: "grounded_synthesis"; text: string; claims: Claim[]; evidenceIds: string[] }
  | { kind: "interpretation"; text: string; claims: Claim[]; evidenceIds: string[] }
  // 根拠を要さない短い応答（挨拶・お礼・相槌・聞き返し）。本人の事実を述べる用途には使わない。
  | { kind: "conversational"; text: string; evidenceIds: string[] };

export type SegmentKind = Segment["kind"];
export type ModelPayload = { segments: Segment[]; answerability: Answerability; confidence: "high" | "medium" | "low" };

// 長さ予算。modeは生成指示、maxは最終本文の上限コードポイント数。
export type LengthBudget = { mode: "brief" | "normal" | "detail"; max: number; target: number };

// 診断は質問本文・回答本文・根拠本文を一切含めない。コード・件数・時間・トークンのみ。
export type DiagnosticCode =
  | "jev_request_complete" | "jev_request_failed"
  | "no_evidence" | "retrieval_miss" | "model_abstained" | "unsupported_claim"
  | "conflicting_facts" | "stale_or_revoked" | "generation_error" | "verification_error"
  | "length_exceeded" | "verification_rejected" | "retrieval_retry" | "repair_attempted"
  | "processing_failure" | "generation_complete" | "verification_complete" | "conversation_reply"
  // 取得候補と採用候補の件数。主指示書§0の再現条件を、本文を含めず件数だけで残す。
  | "candidates_retrieved" | "candidates_adopted"
  // 長さ上限に収まる段落まで削って返した回数。
  | "length_trimmed"
  // 応答全体の時間予算で追加の生成・校閲を打ち切った回数。
  | "time_budget_exhausted"
  // 時間切れによる中断と、利用者による中止。同じ中断でも理由を分けて残す。
  | "answer_timeout" | "answer_aborted"
  // 応答ストリームが例外で終わった回数。失敗しても、止まった段階を後から追えるようにする。
  | "stream_failure"
  // 保存された採点設定が壊れていたため、既定へ戻して回答した回数。
  | "jev_settings_fallback"
  // 生成前の根拠選別（JEV①）の実行・完了・失敗・見送り。
  | "scope_attempt" | "scope_complete" | "scope_error" | "scope_skipped"
  // 選別が候補集合の外の主根拠を返した回数と、低確信だった回数。
  | "scope_primary_rejected" | "scope_low_confidence"
  // 候補が多いときの絞り込み（任意）。
  | "screening_attempt" | "screening_complete" | "screening_error"
  // 根拠IDの表記揺れ（版のID）を、渡した根拠へ寄せた回数。
  | "evidence_id_normalized"
  // 絞り込みで範囲外へ落とした候補と、実際に使った段階数。
  | "screening_dropped" | "stages_used"
  // ビーム探索（複数の根拠ルート）の実行・完了・見送り・追加検索。
  | "beam_attempt" | "beam_complete" | "beam_skipped" | "beam_expanded"
  // 初回採用と修復、前段案内、最終失敗を質問単位で区別する。
  | "beam_merged" | "triage_route" | "answer_accepted" | "candidate_rejected"
  | "pipeline_complete" | "pipeline_failed"
  // 残り時間に収まらないため、修復生成を始めなかった回数。
  | "repair_skipped"
  // 依頼受付時の固定条件（提供元・モデル・指示の版・トレースID）と、選んだ経路。
  // 値は固定の識別子だけで、質問・回答・根拠の本文は含めない。
  | "answer_context" | "route"
  // 事前確認済みの経歴概要を使えたかと、使えなかった理由。
  | "overview_cache"
  // 検索と根拠の再確認にかかった時間。
  | "retrieval_complete" | "generation_attempt" | "jev_attempt" | "jev_complete" | "jev_rejected" | "jev_error"
  | "repair_complete" | "answer_ready" | "stt_complete" | "tts_complete";
export type Diagnostic = {
  code: DiagnosticCode;
  purpose?: "scope" | "screening" | "routes" | "verification";
  count?: number;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  // 機械確認が落ちた理由（quote_not_foundなどの固定識別子）。本文は含めない。
  reason?: string;
  // 採用した根拠の識別子。主指示書§0の再現条件用で、DEBUG_TRACEのときだけ外へ出す。
  ids?: string[];
  // 提供元・モデル名・指示の版・トレースID。いずれも固定の識別子で、本文は含めない。
  provider?: string;
  model?: string;
  promptVersion?: string;
  traceId?: string;
  // 使用した採点設定の版と取得元。どの設定で採点したかを後から確認するために残す。
  settingsVersion?: string;
  settingsSource?: string;
  // JEVの軸別スコア。正答率ではなく未校正の判定値。本文は含めない。
  scores?: Record<string, number>;
  // 生成前の選別の軸別スコア。最終回答の採点とは混ぜない。
  scopeScores?: Record<string, number>;
  // 選別のChoice結果と、Choice/Scoreが返した確信度・支持の強さ。正答率ではない。
  scopeChoice?: string;
  confidence?: number;
  supportStrength?: number;
};
export type DiagnosticsCallback = (diagnostic: Diagnostic) => void;

// プレビュー限定で返す段階記録。診断と同じく固定のコードと数値だけで、本文は含まない。
// 失敗したときも、どの段階まで進んだかを画面上で確認できるようにする。
export type AnswerTrace = {
  code: DiagnosticCode;
  count?: number;
  reason?: string;
  ids?: string[];
  ms?: number;
  inputTokens?: number;
  outputTokens?: number;
  provider?: string;
  model?: string;
  promptVersion?: string;
  traceId?: string;
  settingsVersion?: string;
  settingsSource?: string;
  scores?: Record<string, number>;
  scopeScores?: Record<string, number>;
};

export interface AnswerProvider {
  generateCompact?(input: import("./answer/compact.ts").CompactInput, signal: AbortSignal): Promise<import("./answer/compact.ts").CompactResult>;
  // 取り込み時の公開用候補づくり（#5）。会話の生成とは別に、構造化JSONだけを受け取る。
  generateStructured?(input: { system: string; payload: unknown; schema: unknown; maxTokens?: number },
    signal: AbortSignal): Promise<{ value: unknown; usage?: { input: number; output: number } }>;
  stream(input: {
    question: string;
    history: Turn[];
    evidence: Evidence[];
    highRisk: boolean;
    purpose?: "answer" | "verify";
    candidate?: ModelPayload;
    repair?: string;
    lengthBudget?: LengthBudget;
  }, signal: AbortSignal): AsyncIterable<{ type: "segment"; segment: Segment }
    // 校閲の判定理由。修復指示を具体的にするため、providerから呼び出し側へ渡す。
    | { type: "complete"; payload: ModelPayload; usage?: { input: number; output: number }; verification?: { accepted: boolean; reason: string } }>;
}
export type ChatEvent =
  | { type: "start"; answerId: string }
  | { type: "text"; text: string; answerId: string }
  | { type: "done"; answerId: string; answerability: Answerability; latencyMs: number; firstTextMs: number | null; retrievalSimilarityPercent?: number | null; metrics?: import("./answer/metrics.ts").AnswerMetrics }
  | { type: "error"; code: string; message: string }
  // プレビュー限定の段階記録。固定のコードと数値だけで、質問・回答・根拠の本文は含まない。
  | { type: "trace"; trace: AnswerTrace[] };
export interface Bindings {
  DB: Database;
  VECTORIZE: VectorIndex;
  AI?: AiBinding;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENCODE_API_KEY?: string;
  // 本人専用の管理操作（JEVの採点設定）に使う。試用版の閲覧鍵とは別に扱う。
  ADMIN_TOKEN?: string;
  VOICE_ENABLED?: string;
  VOICE_STT_MODEL?: string;
  VOICE_TTS_MODEL?: string;
  VOICE_TTS_MODE?: string;
  VOICE_NAME?: string;
  VOICE_PLAYBACK_RATE?: string;
  VOICE_DAILY_REQUEST_LIMIT?: string;
  VOICE_IP_HOURLY_LIMIT?: string;
  ANSWER_PROVIDER?: string;
  ANSWER_MODEL?: string;
  OPENCODE_JSON_MODE?: string;
  EMBEDDING_PROVIDER?: string;
  OWNER_ID?: string;
  OWNER_DISPLAY_NAME?: string;
  CAREER_OVERVIEW_JSON?: string;
  OPENAI_MODEL?: string;
  EMBEDDING_MODEL?: string;
  EMBEDDING_DIMENSIONS?: string;
  DAILY_REQUEST_LIMIT?: string;
  IP_HOURLY_LIMIT?: string;
  DEBUG_TRACE?: string;
  ANSWER_PIPELINE?: string;
  TYPESAFE_API_KEY?: string;
  JEV_THRESHOLDS_JSON?: string;
  JEV_TIMEOUT_MS?: string;
  ANSWER_TIMEOUT_MS?: string;
  PREVIEW_ONLY?: string;
  PREVIEW_ACCESS_TOKEN?: string;
  // 取り込みの登録先の説明（管理画面の承認確認に出す）。未設定なら公開サイト共用の既定文言を使う。
  INTAKE_DESTINATION_LABEL?: string;
  ASSETS?: { fetch(request: Request): Promise<Response> };
}
