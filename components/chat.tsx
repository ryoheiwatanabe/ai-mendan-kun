"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatEvent, Turn } from "../lib/types.ts";
import { readSse } from "../lib/ai/sse.ts";
import { nextQuestions } from "./chat-suggestions.ts";
import { AnswerDiagnosticsSwitch, AnswerDiagnosticsValue } from "./answer-diagnostics";

type Message = Turn & { id: string; complete: boolean; retrievalSimilarityPercent?: number | null };

export function Chat() {
  const [started, setStarted] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const run = useRef(0);
  const follow = useRef(true);
  const completedQuestions = messages.flatMap((message, index) => message.role === "user" && messages[index + 1]?.role === "assistant" && messages[index + 1].complete ? [message.content] : []);
  const suggestions = nextQuestions(completedQuestions);

  useEffect(() => () => { abort.current?.abort(); }, []);
  useEffect(() => { if (list.current && follow.current) list.current.scrollTop = list.current.scrollHeight; }, [messages, busy, showDiagnostics]);

  function stop() { abort.current?.abort(); run.current++; setBusy(false); }
  function end() { stop(); setMessages([]); setDraft(""); setError(""); setStarted(false); }

  async function send(text = draft) {
    if (busy || !text.trim() || text.length > 1000) return;
    const current = ++run.current;
    follow.current = true;
    const controller = new AbortController();
    abort.current = controller;
    setStarted(true); setError(""); setDraft(""); setBusy(true);
    // 完了した往復だけを次ターンへ送る。停止・失敗時の断片は根拠にも文脈にも混ぜない。
    const history: Turn[] = [];
    for (let i = 0; i < messages.length - 1; i++) {
      if (messages[i].role === "user" && messages[i + 1].role === "assistant" && messages[i + 1].complete) history.push({ role: "user", content: messages[i].content }, { role: "assistant", content: messages[i + 1].content });
    }
    while (history.length > 12 || history.reduce((sum, turn) => sum + turn.content.length, 0) > 5500) history.splice(0, 2);
    const id = crypto.randomUUID();
    setMessages(previous => [...previous, { id: `${id}:user`, role: "user", content: text.trim(), complete: true }, { id, role: "assistant", content: "", complete: false }]);
    let complete = false;
    let retrievalSimilarityPercent: number | null | undefined;
    try {
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "meeting_text", message: text.trim(), history }), signal: controller.signal });
      if (!response.ok) { const data = await response.json() as { error?: { message?: string } }; throw new Error(data.error?.message || "接続できませんでした。もう一度お試しください。"); }
      if (!response.body) throw new Error("回答を受け取れませんでした。");
      for await (const raw of readSse(response.body, controller.signal)) {
        if (current !== run.current) return;
        const event = JSON.parse(raw) as ChatEvent;
        if (event.type === "text") setMessages(previous => previous.map(message => message.id === id ? { ...message, content: message.content + event.text } : message));
        if (event.type === "error") throw new Error(event.message);
        if (event.type === "done") { complete = true; retrievalSimilarityPercent = event.retrievalSimilarityPercent; }
      }
      if (current !== run.current || controller.signal.aborted) return;
      if (!complete) throw new Error("回答が途中で止まりました。もう一度お試しください。");
      setMessages(previous => previous.map(message => message.id === id ? { ...message, complete: true, retrievalSimilarityPercent } : message));
    } catch (cause) {
      if (current === run.current && !controller.signal.aborted) { setError(cause instanceof Error ? cause.message : "回答を受け取れませんでした。"); setDraft(text); }
    } finally { if (current === run.current) { setBusy(false); textarea.current?.focus(); } }
  }

  return <section className="chat-panel" aria-label="AI面談">
    <div className="chat-top"><div><span className="status-dot" aria-hidden="true" /><span>AI面談</span></div><span className="private-label">会話の記録なし</span>{started && <button className="quiet-button" onClick={end}>終了する</button>}</div>
    <AnswerDiagnosticsSwitch enabled={showDiagnostics} onChange={setShowDiagnostics} />
    {!started ? <div className="welcome"><div className="conversation-mark" aria-hidden="true">「<span>…</span>」</div><h2>どんなことを<br />聞いてみたいですか？</h2><p>まずは気になるところから。<br />短い質問でも大丈夫です。</p><button className="primary-button" onClick={() => { setStarted(true); setTimeout(() => textarea.current?.focus(), 0); }}>AI面談をはじめる <span aria-hidden="true">→</span></button><span className="welcome-foot">本人が公開用に確認した情報から回答します。</span></div>
      : <div className="conversation" ref={list} onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < 100; }} role="log" aria-label="会話履歴" aria-live="polite" aria-relevant="additions text">
        {!messages.length && <div className="first-message"><span className="speaker">AI面談くん</span><p>こんにちは。経歴や仕事での経験など、気になることを聞いてみてください。</p></div>}
        {messages.map(message => <article className={`message message-${message.role}`} key={message.id}><span className="speaker">{message.role === "user" ? "あなた" : "AI面談くん"}</span><p>{message.content || (busy && message.id === messages[messages.length - 1]?.id ? "思い出しています…" : "回答は完了していません。")}</p>{showDiagnostics && message.role === "assistant" && message.complete && <AnswerDiagnosticsValue percent={message.retrievalSimilarityPercent} />}{!message.complete && message.content && !busy && <small>回答は途中で終了しました。</small>}</article>)}
      </div>}
    <div className="chat-bottom">
      <div className="suggestions" role="group" aria-label="質問の候補">{suggestions.map(question => <button key={question} disabled={busy} onClick={() => send(question)}>{question}<span aria-hidden="true">↗</span></button>)}</div>
      {error && <p role="alert" className="error-message">{error}</p>}
      {started && <form onSubmit={event => { event.preventDefault(); void send(); }} className="composer"><label className="sr-only" htmlFor="question">質問を入力</label><textarea ref={textarea} id="question" rows={2} maxLength={1000} placeholder="気になることを、自由に。" value={draft} onChange={event => setDraft(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && !composing.current) { event.preventDefault(); void send(); } }} /><div className="composer-actions"><span>{draft.length}/1,000</span>{busy ? <button type="button" className="send-button" onClick={stop}>停止</button> : <button className="send-button" disabled={!draft.trim()}>送信 <span aria-hidden="true">↑</span></button>}</div></form>}
      <p className="input-note">大切な条件や判断は、面談で本人にご確認ください。</p>
    </div>
  </section>;
}
