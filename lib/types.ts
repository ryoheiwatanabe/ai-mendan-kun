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
export interface EmbeddingProvider { embed(text: string, signal?: AbortSignal, purpose?: "query" | "document"): Promise<number[]> }
export type Evidence = {
  id: string;
  revisionId: string;
  documentId: string;
  title: string;
  content: string;
  contentHash: string;
  entities: string[];
  kind: "chunk" | "exact_fact";
  rank: number;
};
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
export type Segment = { kind: "fact" | "interpretation"; text: string; evidenceIds: string[] };
export type ModelPayload = { segments: Segment[]; answerability: Answerability; confidence: "high" | "medium" | "low" };
export interface AnswerProvider {
  stream(input: { question: string; history: Turn[]; evidence: Evidence[]; highRisk: boolean }, signal: AbortSignal): AsyncIterable<{ type: "segment"; segment: Segment } | { type: "complete"; payload: ModelPayload; usage?: { input: number; output: number } }>;
}
export type ChatEvent =
  | { type: "start"; answerId: string }
  | { type: "text"; text: string; answerId: string }
  | { type: "done"; answerId: string; answerability: Answerability; latencyMs: number; firstTextMs: number | null }
  | { type: "error"; code: string; message: string };
export interface Bindings {
  DB: Database;
  VECTORIZE: VectorIndex;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  VOICE_ENABLED?: string;
  VOICE_STT_MODEL?: string;
  VOICE_TTS_MODEL?: string;
  VOICE_NAME?: string;
  VOICE_DAILY_REQUEST_LIMIT?: string;
  VOICE_IP_HOURLY_LIMIT?: string;
  ANSWER_PROVIDER?: string;
  ANSWER_MODEL?: string;
  EMBEDDING_PROVIDER?: string;
  OWNER_ID?: string;
  OWNER_DISPLAY_NAME?: string;
  OPENAI_MODEL?: string;
  EMBEDDING_MODEL?: string;
  EMBEDDING_DIMENSIONS?: string;
  DAILY_REQUEST_LIMIT?: string;
  IP_HOURLY_LIMIT?: string;
}
