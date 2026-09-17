// D条件: 同一候補に対する校閲比較のうち、JEV（TypeSafe）側の専用クライアント。
// - 生成用の LAB_API_KEY とは別に、TYPESAFE_API_KEY を使う。
// - 送信先は許可リストのホストだけ。値は表示・保存しない。
// - 判定は小さな項目に分け、1回のAPIへまとめる。
import type { Evidence, Turn } from "../../../lib/types.ts";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_HOST = "api.typesafe.ai";
export const JEV_MODEL = "jev-latest";

// 判定項目。noul は「その主張が真である確率」を0〜1で返す。
export const jevQuestions = {
  target_match: { type: "noul", instructions: "候補回答は、質問が指す対象（人物・時期・会社・プロジェクト）と一致していますか。会話履歴は照応の解決にだけ使い、事実の根拠は根拠本文に限定してください。" },
  aspect_match: { type: "noul", instructions: "候補回答は、質問が求めている項目（経歴・担当・由来・苦労・実務例・金額の帰属など）に実質的に答えていますか。同じ話題というだけでは合格にしないでください。" },
  claims_supported: { type: "noul", instructions: "候補回答の事実と限定的な推論は、根拠本文の意味に支えられていますか。意味を保つ要約や一人称化は許容し、根拠にない事実の追加は認めないでください。" },
  no_invented_causality: { type: "noul", instructions: "候補回答は、単なる背景の記述から形成原因・因果関係を創作していませんか。創作が無ければ高い確率を返してください。" },
  no_scope_expansion: { type: "noul", instructions: "候補回答は、数値の主体・担当範囲・条件・時期・否定を変えていませんか。変えていなければ高い確率を返してください。" },
  no_unnecessary_abstention: { type: "noul", instructions: "根拠本文に答えられる情報があるのに、候補回答が不明・確認依頼で終わっていませんか。答えられる情報を使っていれば高い確率を返してください。" }
} as const;

export type JevQuestionId = keyof typeof jevQuestions;

export interface JevAnswer {
  type: string;
  probability: number | null;
  choice: string | null;
  confidence: number | null;
  raw: unknown;
}

export interface JevResult {
  ok: boolean;
  errorKind: string | null;
  latencyMs: number;
  usage: { inputTokens: number | null; outputTokens: number | null };
  answers: Record<string, JevAnswer>;
  httpStatus: number | null;
}

export function jevState(input: { question: string; history: Turn[]; evidence: Evidence[]; candidate: string }): string {
  return JSON.stringify({
    question: input.question,
    history: input.history.map(turn => ({ role: turn.role, content: turn.content })),
    evidence: input.evidence.map(item => ({ id: item.id, kind: item.kind, title: item.title, text: item.content })),
    candidate: input.candidate
  });
}

export function buildJevRequest(input: {
  question: string; history: Turn[]; evidence: Evidence[]; candidate: string; model?: string;
}): Record<string, unknown> {
  return {
    state: jevState(input),
    model: input.model ?? JEV_MODEL,
    questions: jevQuestions
  };
}

// 応答を、項目ごとの確率・選択・confidenceへ写す。生の値も保持する。
export function parseJevResponse(value: unknown): { answers: Record<string, JevAnswer>; usage: { inputTokens: number | null; outputTokens: number | null } } {
  const body = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const raw = (body.answers && typeof body.answers === "object" ? body.answers : {}) as Record<string, unknown>;
  const usage = (body.usage && typeof body.usage === "object" ? body.usage : {}) as Record<string, unknown>;
  const answers: Record<string, JevAnswer> = {};
  for (const [key, item] of Object.entries(raw)) {
    const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    answers[key] = {
      type: typeof entry.type === "string" ? entry.type : "unknown",
      probability: typeof entry.probability === "number" ? entry.probability : null,
      choice: typeof entry.choice === "string" ? entry.choice : null,
      confidence: typeof entry.confidence === "number" ? entry.confidence : null,
      raw: entry
    };
  }
  const number = (field: unknown) => typeof field === "number" ? field : null;
  return { answers, usage: { inputTokens: number(usage.input_tokens), outputTokens: number(usage.output_tokens) } };
}

export function jevKeyFromEnv(env: Record<string, string | undefined> = process.env): string {
  const key = env.TYPESAFE_API_KEY ?? "";
  if (!key) throw new Error("TYPESAFE_API_KEY が未設定です（生成用のLAB_API_KEYとは別に渡してください）。");
  return key;
}

// 接続先は許可リストのホストだけ。エンドポイントを手入力で差し替えられないようにする。
export function assertJevEndpoint(endpoint: string, allowedHosts: string[]): string {
  const host = new URL(endpoint).host;
  if (!allowedHosts.includes(host)) throw new Error("host_not_allowed: " + host);
  return host;
}

export async function evaluateJev(input: {
  question: string; history: Turn[]; evidence: Evidence[]; candidate: string;
  apiKey: string; endpoint?: string; model?: string; timeoutMs: number; signal?: AbortSignal;
}): Promise<JevResult> {
  const endpoint = input.endpoint ?? JEV_ENDPOINT;
  assertJevEndpoint(endpoint, (process.env.LAB_JEV_ALLOWED_HOSTS ?? JEV_HOST).split(",").map(value => value.trim()));
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: "Bearer " + input.apiKey, "Content-Type": "application/json", "User-Agent": "ai-mendan-kun-lab/0.1" },
      body: JSON.stringify(buildJevRequest(input)),
      signal
    });
    const latencyMs = Math.round(performance.now() - started);
    if (!response.ok) {
      await response.text().catch(() => "");
      return { ok: false, errorKind: "http_" + String(response.status), latencyMs, usage: { inputTokens: null, outputTokens: null },
        answers: {}, httpStatus: response.status };
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, errorKind: "invalid_json", latencyMs, usage: { inputTokens: null, outputTokens: null }, answers: {}, httpStatus: response.status };
    }
    const result = parseJevResponse(parsed);
    return { ok: true, errorKind: null, latencyMs, usage: result.usage, answers: result.answers, httpStatus: response.status };
  } catch {
    return {
      ok: false, errorKind: controller.signal.aborted ? "timeout" : "network_error",
      latencyMs: Math.round(performance.now() - started), usage: { inputTokens: null, outputTokens: null }, answers: {}, httpStatus: null
    };
  } finally {
    clearTimeout(timer);
  }
}
