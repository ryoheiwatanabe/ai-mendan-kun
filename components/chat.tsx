"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatEvent } from "../lib/types.ts";
import { readSse } from "../lib/ai/sse.ts";
import { nextQuestions } from "./chat-suggestions.ts";
import { ConversationDiagnostics } from "./answer-diagnostics";
import { EntryChoices } from "./entry-choices";
import { measureTextLatency, type TextLatency } from "../lib/voice/latency.ts";
import { TestRecordingNotice, useTestRecording } from "./test-recording";
import { recordingFetch, recordTestEvent } from "../lib/test-recording.ts";
import { answerFailureMessage, conversationLabels, historyFrom, sendable, traceSummary, type ConversationMessage } from "../lib/conversation.ts";

type Message = ConversationMessage & { latency?: TextLatency; inputPending?: boolean };

export function Chat({ processors = "設定された外部AI API" }: { processors?: string }) {
  const recording = useTestRecording();
  const [started, setStarted] = useState(false);
  function begin() { setStarted(true); }
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 失敗したときに、どこまで進んだかを画面で確かめるための段階記録（プレビュー限定）。
  const [failureDetail, setFailureDetail] = useState("");
  const abort = useRef<AbortController | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const run = useRef(0);
  const follow = useRef(true);
  const completedQuestions = messages.flatMap((message, index) => message.role === "user" && messages[index + 1]?.role === "assistant" && messages[index + 1].complete ? [message.content] : []);
  const suggestions = nextQuestions(completedQuestions);

  useEffect(() => () => { abort.current?.abort(); }, []);
  useEffect(() => { if (list.current && follow.current) list.current.scrollTop = list.current.scrollHeight; }, [messages, busy]);
  useEffect(() => {
    recordTestEvent("text-state", { started, busy, error, messages: messages.slice(-2),
      greeting: started && !messages.length ? "こんにちは。経歴や仕事での経験など、気になることを聞いてみてください。" : "" });
  }, [started, busy, error, messages, recording.enabled]);
  useEffect(() => {
    const leave = () => recordTestEvent("text-pagehide", {}, true);
    window.addEventListener("pagehide", leave);
    return () => window.removeEventListener("pagehide", leave);
  }, []);
  useEffect(() => { if (recording.enabled && !recording.healthy) { abort.current?.abort(); run.current++; setBusy(false); } }, [recording.enabled, recording.healthy]);
  // 入口から始めた場合も、そのまま入力できるように入力欄へ移す。
  useEffect(() => { if (started) textarea.current?.focus(); }, [started]);

  function stop() {
    recordTestEvent("text-stop", {}); abort.current?.abort(); run.current++; setBusy(false);
    setMessages(previous => previous.map(message => message.inputPending
      ? { ...message, content: "送信を止めました。", inputPending: false } : message));
  }
  function end() { recordTestEvent("text-end", {}); stop(); setMessages([]); setDraft(""); setError(""); setFailureDetail(""); setStarted(false); }

  async function send(text = draft) {
    if (!sendable(text, { busy, blocked: recording.enabled && !recording.healthy })) return;
    const current = ++run.current;
    follow.current = true;
    const controller = new AbortController();
    abort.current = controller;
    begin(); setError(""); setFailureDetail(""); setDraft(""); setBusy(true);
    // 完了した往復だけを次ターンへ送る。停止・失敗時の断片は根拠にも文脈にも混ぜない。
    const history = historyFrom(messages);
    const id = crypto.randomUUID();
    setMessages(previous => [...previous, { id: `${id}:user`, role: "user", content: "入力を確認しています…", complete: false, inputPending: true }, { id, role: "assistant", content: "", complete: false }]);
    let complete = false;
    // 失敗の本文は、段階記録を最後まで受け取ってから表示する。
    let failure = "", stage = "";
    let metrics: ConversationMessage["metrics"];
    let retrievalSimilarityPercent: number | null | undefined;
    // 文字の応答時間も、音声と同じブラウザー時計で測る。
    const startedAt = performance.now();
    let firstTextAt: number | null = null;
    let doneAt: number | null = null;
    try {
      const response = await recordingFetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "meeting_text", message: text.trim(), history }), signal: controller.signal });
      if (!response.ok) { const data = await response.json() as { error?: { message?: string } }; throw new Error(data.error?.message || "接続できませんでした。もう一度お試しください。"); }
      if (!response.body) throw new Error("回答を受け取れませんでした。");
      for await (const raw of readSse(response.body, controller.signal)) {
        if (current !== run.current) return;
        const event = JSON.parse(raw) as ChatEvent;
        if (event.type === "input") setMessages(previous => previous.map(message => message.id === `${id}:user`
          ? { ...message, content: event.question, complete: !event.blocked, inputPending: false } : message));
        if (event.type === "text") { if (firstTextAt === null) firstTextAt = performance.now();
          setMessages(previous => previous.map(message => message.id === id ? { ...message, content: message.content + event.text } : message)); }
        if (event.type === "error") failure = answerFailureMessage(event.code, event.message);
        if (event.type === "trace") stage = traceSummary(event.trace);
        if (event.type === "done") { complete = true; doneAt = performance.now(); retrievalSimilarityPercent = event.retrievalSimilarityPercent; metrics = event.metrics; }
      }
      if (current !== run.current || controller.signal.aborted) return;
      if (failure) throw new Error(failure);
      if (!complete) throw new Error("回答が途中で止まりました。もう一度お試しください。");
      const latency = doneAt === null ? null : measureTextLatency({ startedAt, firstTextAt, doneAt });
      setMessages(previous => previous.map(message => message.id === id
        ? { ...message, complete: true, retrievalSimilarityPercent, metrics, ...(latency ? { latency } : {}) } : message));
    } catch (cause) {
      if (current === run.current && !controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "回答を受け取れませんでした。");
        setFailureDetail(stage); setDraft(text);
      }
    } finally { if (current === run.current) {
      setMessages(previous => previous.map(message => message.id === `${id}:user` && message.inputPending
        ? { ...message, content: "入力を確認できませんでした。", inputPending: false } : message));
      setBusy(false); textarea.current?.focus();
    } }
  }

  return <><section className="chat-panel" aria-label="AI面談">
    <div className="chat-top"><div><span className="status-dot" aria-hidden="true" /><span>AI面談</span></div><span className="private-label">{recording.enabled ? "検証用に記録中" : "会話の記録なし"}</span>{started && <button className="quiet-button" onClick={end}>終了する</button>}</div>
    <TestRecordingNotice status={recording} />
    {!started ? <div className="welcome"><h2>話す方法を選んでください</h2><EntryChoices onText={begin} /></div>
      : <div className="conversation" ref={list} onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < 100; }} role="log" aria-label="会話履歴" aria-live="polite" aria-relevant="additions text">
        {!messages.length && <div className="first-message"><span className="speaker">AI面談くん</span><p>こんにちは。経歴や仕事での経験など、気になることを聞いてみてください。</p></div>}
        {messages.map(message => <article className={`message message-${message.role}`} key={message.id}><span className="speaker">{message.role === "user" ? "あなた" : "AI面談くん"}</span><p>{message.content || (busy && message.id === messages[messages.length - 1]?.id ? conversationLabels.thinking : conversationLabels.notCompleted)}</p>{!message.complete && message.content && !busy && <small>{conversationLabels.interrupted}</small>}</article>)}
      </div>}
    <div className="chat-bottom">
      <div className="suggestions" role="group" aria-label="質問の候補">{suggestions.map(question => <button key={question} disabled={busy || recording.enabled && !recording.healthy} onClick={() => send(question)}>{question}<span aria-hidden="true">↗</span></button>)}</div>
      {error && <p role="alert" className="error-message">{error}</p>}
      {started && <form onSubmit={event => { event.preventDefault(); void send(); }} className="composer"><label className="sr-only" htmlFor="question">質問を入力</label><textarea ref={textarea} id="question" rows={2} maxLength={1000} placeholder="気になることを、自由に。" value={draft} onChange={event => setDraft(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && !composing.current) { event.preventDefault(); void send(); } }} /><div className="composer-actions"><span>{draft.length}/1,000</span>{busy ? <button type="button" className="send-button" onClick={stop}>停止</button> : <button className="send-button" disabled={!draft.trim() || recording.enabled && !recording.healthy}>送信 <span aria-hidden="true">↑</span></button>}</div></form>}
      <p className="input-note">送信すると、質問・直近の会話・必要な公開承認済み情報を{processors}へ送り、回答を作成・確認します。大切な条件や判断は、面談で本人にご確認ください。</p>
    </div>
  </section>
    <ConversationDiagnostics mode="text" messages={messages} failureDetail={failureDetail} />
  </>;
}
