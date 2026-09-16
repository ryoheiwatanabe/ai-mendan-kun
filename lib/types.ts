export type ApprovalStatus = "draft" | "approved" | "superseded" | "rejected" | "revoked";
export type Visibility = "public" | "interview" | "private";
export type Answerability = "answerable" | "partial" | "unknown" | "ambiguous";
export type Turn = { role: "user" | "assistant"; content: string };
export type ChatRequest = { mode: "meeting_text"; message: string; history: Turn[] };
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
  run(model: string, input: { text: string[] }): Promise<{ data?: number[][] }>;
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
  | "no_evidence" | "retrieval_miss" | "model_abstained" | "unsupported_claim"
  | "conflicting_facts" | "stale_or_revoked" | "generation_error" | "verification_error"
  | "length_exceeded" | "verification_rejected" | "retrieval_retry" | "repair_attempted"
  | "processing_failure" | "generation_complete" | "verification_complete" | "conversation_reply"
  // 取得候補と採用候補の件数。主指示書§0の再現条件を、本文を含めず件数だけで残す。
  | "candidates_retrieved" | "candidates_adopted";
export type Diagnostic = {
  code: DiagnosticCode;
  count?: number;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
};
export type DiagnosticsCallback = (diagnostic: Diagnostic) => void;

export interface AnswerProvider {
  stream(input: {
    question: string;
    history: Turn[];
    evidence: Evidence[];
    highRisk: boolean;
    purpose?: "answer" | "verify";
    candidate?: ModelPayload;
    repair?: string;
    lengthBudget?: LengthBudget;
  }, signal: AbortSignal): AsyncIterable<{ type: "segment"; segment: Segment } | { type: "complete"; payload: ModelPayload; usage?: { input: number; output: number } }>;
}
export type ChatEvent =
  | { type: "start"; answerId: string }
  | { type: "text"; text: string; answerId: string }
  | { type: "done"; answerId: string; answerability: Answerability; latencyMs: number; firstTextMs: number | null; retrievalSimilarityPercent?: number | null }
  | { type: "error"; code: string; message: string };
export interface Bindings {
  DB: Database;
  VECTORIZE: VectorIndex;
  AI?: AiBinding;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENCODE_API_KEY?: string;
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
}
