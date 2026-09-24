// 実験ラボの型。本番の型（lib/types.ts）とは用途が違うため独立して持つ。
export type Approval = "approved" | "unapproved" | "revoked";
export type Visibility = "public" | "private";

export interface EvidenceUnit {
  id: string;
  text: string;
  sourceId: string;
  sourceRevision: string;
  contentHash: string;
  approval: Approval;
  visibility: Visibility;
  subjectId?: string;
  period?: { from?: string; to?: string };
  evidenceType?: "explicit_fact" | "self_reflection" | "approved_summary";
  causalStatus?: "explicit" | "not_established";
}

export interface FictionalProfile {
  note: string;
  subjectId: string;
  sourceRevisions: Record<string, string>;
  evidence: EvidenceUnit[];
}

export interface CaseGold {
  mustInclude: string[];
  mustNot: string[];
  allowedLimitation: string | null;
}

export interface LabCase {
  id: string;
  question: string;
  historyId: string | null;
  selection: string[];
  simulate?: "timeout";
  gold: CaseGold;
}

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

// 根拠を使えなかった理由。モデルへ渡す前に落とす。
export type ExcludeReason = "not_found" | "unapproved" | "revoked" | "private" | "other_subject" | "stale_revision";

export interface ExcludedUnit {
  id: string;
  reason: ExcludeReason;
}

export interface CallTiming {
  apiStartMs: number;
  firstTokenMs: number | null;
  completeMs: number | null;
  totalMs: number;
}

export interface CallUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface AnswerPayload {
  answer: string;
  sourceIds: string[];
  limitations: string;
}

export interface ManualLabel {
  targetMatch: string;
  aspectMatch: string;
  supported: string;
  notes: string;
  at: string;
}

export interface RunRecord {
  runId: string;
  at: string;
  baseSha: string;
  phase: "phase1";
  mode: "A";
  caseId: string;
  question: string;
  historyId: string | null;
  selection: string[];
  sentEvidenceIds: string[];
  excluded: ExcludedUnit[];
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  promptVersion: string;
  status: "ok" | "error";
  errorKind: string | null;
  answer: string;
  sourceIds: string[];
  limitations: string;
  timing: CallTiming;
  usage: CallUsage;
  apiCalls: number;
  label: ManualLabel | null;
}
