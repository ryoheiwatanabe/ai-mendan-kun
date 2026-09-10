import type { ChatRequest, Turn } from "../types.ts";

export class PublicError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) { super(message); this.code = code; this.status = status; }
}
export const MAX_BODY_BYTES = 24_000;

export async function readRequest(request: Request): Promise<ChatRequest> {
  if (!request.headers.get("content-type")?.includes("application/json")) throw new PublicError("INVALID_INPUT", 400, "質問を確認して、もう一度送信してください。");
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) throw new PublicError("TOO_LARGE", 413, "質問と会話が長すぎます。新しい会話でお試しください。");
  const reader = request.body?.getReader();
  if (!reader) throw new PublicError("INVALID_INPUT", 400, "質問を入力してください。");
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.length;
    if (length > MAX_BODY_BYTES) { await reader.cancel(); throw new PublicError("TOO_LARGE", 413, "質問と会話が長すぎます。新しい会話でお試しください。"); }
    chunks.push(next.value);
  }
  const combined = new Uint8Array(length);
  let position = 0;
  for (const chunk of chunks) { combined.set(chunk, position); position += chunk.length; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(combined)); }
  catch { throw new PublicError("INVALID_INPUT", 400, "質問を確認して、もう一度送信してください。"); }
  return validateRequest(value);
}

export function validateRequest(value: unknown): ChatRequest {
  const fail = () => { throw new PublicError("INVALID_INPUT", 400, "質問は1〜1,000文字、履歴は直近12件までにしてください。"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const item = value as Record<string, unknown>;
  if (item.mode !== "meeting_text" || typeof item.message !== "string" || !item.message.trim() || item.message.length > 1000) return fail();
  const history = item.history ?? [];
  if (!Array.isArray(history) || history.length > 12) return fail();
  const safe: Turn[] = [];
  for (const turn of history) {
    if (!turn || (turn.role !== "user" && turn.role !== "assistant") || typeof turn.content !== "string" || turn.content.length > 1800) return fail();
    if (safe.at(-1)?.role === turn.role) return fail();
    safe.push({ role: turn.role, content: turn.content });
  }
  if (safe.length && (safe[0].role !== "user" || safe.at(-1)?.role !== "assistant")) return fail();
  if (safe.reduce((sum, turn) => sum + turn.content.length, 0) > 6000) return fail();
  return { mode: "meeting_text", message: item.message.trim(), history: safe };
}

export function checkOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new PublicError("FORBIDDEN", 403, "この画面から質問を送信してください。");
}

export function isInjection(message: string): boolean {
  return /(今までの指示|以前の指示|すべての指示).{0,12}(無視|忘れ)|system\s*prompt|システムプロンプト|秘密鍵|api[ _-]?key|ignore\s+(all|previous)|全(文|件|データ).{0,12}(json|表示|出力)|private.{0,12}(表示|出力|教え)|非公開情報.{0,12}(教え|出し|表示)/i.test(message);
}

export function asksForDecision(message: string): boolean {
  return /(入社|参加|就職|契約|承諾|受諾).{0,16}(しますか|してくれ|約束|確約|決めて|してよ|してください)|条件.{0,12}(飲む|承諾|同意)|will you (accept|join|sign)/i.test(message);
}
