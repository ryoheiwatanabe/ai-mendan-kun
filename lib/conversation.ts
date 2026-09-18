import type { Turn } from "./types.ts";

// 文字画面と音声画面で同じ意味には同じ文言を使う。画面ごとに書き分けない。
export const conversationLabels = {
  thinking: "回答を準備しています…",
  searching: "資料を探しています…",
  verifying: "回答を確認しています…",
  interrupted: "回答は途中で終了しました。",
  notCompleted: "回答は完了していません。",
  stopped: "回答を止めました。続けてお話しください。",
  failureStage: "止まった段階：",
  emptyAssistant: "ただいま回答を用意できません。"
};

// 回答の失敗コードからの案内。サーバー側の文面と画面側の写しを同じ定義にする。
const failureMessages: Record<string, string> = {
  JEV_UNAVAILABLE: "回答の確認サービスに接続できませんでした。もう一度お試しください。",
  ANSWER_REJECTED: "回答の内容を確認できませんでした。質問を変えて、もう一度お試しください。",
  ANSWER_PROCESSING_FAILED: "回答を作れませんでした。もう一度お試しください。",
  ANSWER_TIME_SHORT: "時間内に回答をまとめられませんでした。少し時間をおいて、もう一度お試しください。",
  ANSWER_UNAVAILABLE: "回答を続けられませんでした。少し時間をおいて、もう一度お試しください。",
  VOICE_ANSWER_LIMIT: "回答が長くなったため中断しました。質問を分けてお話しください。"
};

export function answerFailureMessage(code: string | undefined, fallback: string): string {
  return code ? failureMessages[code] ?? fallback : fallback;
}

export type ConversationMessage = Turn & { id: string; complete: boolean;
  retrievalSimilarityPercent?: number | null };

// 次へ送る履歴は、完了した往復だけ。停止・失敗の断片を文脈にも根拠にも混ぜない。
export function historyFrom(messages: readonly ConversationMessage[]): Turn[] {
  const history: Turn[] = [];
  for (let index = 0; index + 1 < messages.length; index++) {
    const user = messages[index], assistant = messages[index + 1];
    if (user.role === "user" && assistant.role === "assistant" && assistant.complete && assistant.content.trim())
      history.push({ role: "user", content: user.content }, { role: "assistant", content: assistant.content });
  }
  while (history.length > 12 || history.reduce((sum, turn) => sum + turn.content.length, 0) > 5500) history.splice(0, 2);
  return history;
}

export const conversationLimits = { messageLength: 1000, answerLength: 6000 };

// 二重送信・空送信・長すぎる入力を、両画面で同じ条件で止める。
export function sendable(text: string, options: { busy: boolean; blocked?: boolean }): boolean {
  const message = text.trim();
  return !options.busy && !options.blocked && !!message && message.length <= conversationLimits.messageLength;
}

// 会話の本文を持つ状態。文字画面はReact側で、音声画面はVoiceSessionで同じ規則を使う。
export class ConversationState<T extends ConversationMessage = ConversationMessage> {
  private entries: T[] = [];
  get messages(): readonly T[] { return this.entries; }

  begin(userText: string, id = crypto.randomUUID()): { id: string; user: T; assistant: T } {
    const user = { id: `${id}:user`, role: "user", content: userText, complete: true } as T;
    const assistant = { id, role: "assistant", content: "", complete: false } as T;
    this.entries = [...this.entries, user, assistant];
    return { id, user, assistant };
  }
  append(id: string, text: string): number {
    let length = 0;
    this.entries = this.entries.map(message => {
      if (message.id !== id) return message;
      length = message.content.length + text.length;
      return { ...message, content: message.content + text };
    });
    return length;
  }
  merge(id: string, extra: Partial<T>): void {
    this.entries = this.entries.map(message => message.id === id ? { ...message, ...extra } : message);
  }
  complete(id: string, extra: Partial<T> = {}): void {
    this.entries = this.entries.map(message => message.id === id ? { ...message, ...extra, complete: true } : message);
  }
  // 停止・失敗で確定できなかった回答を、履歴へ混ぜない印として残す。
  interrupt(id: string): void {
    this.entries = this.entries.map(message => message.id === id ? { ...message, complete: false } : message);
  }
  reset(): void { this.entries = []; }
  history(): Turn[] { return historyFrom(this.entries); }
}

// 失敗や拒否の段階。プレビュー限定の記録を、画面で読める短い並びにする。
export function traceSummary(trace: readonly { code: string; reason?: string; ms?: number }[], limit = 8): string {
  return trace.slice(-limit).map(entry =>
    `${entry.code}${entry.reason ? `(${entry.reason})` : ""}${entry.ms === undefined ? "" : ` ${entry.ms}ms`}`).join(" → ");
}
