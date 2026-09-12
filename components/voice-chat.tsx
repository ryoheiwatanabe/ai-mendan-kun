"use client";

import { useEffect, useRef, useState } from "react";
import { initialVoiceSnapshot, supportsVoice, VoiceSession } from "../lib/voice/browser.ts";
import type { VoiceConfiguration } from "../lib/voice/types.ts";
import { AnswerDiagnosticsSwitch, AnswerDiagnosticsValue } from "./answer-diagnostics";
import { VoiceLatencyDetails } from "./voice-latency";

const labels = {
  idle: "声で、話してみませんか。", starting: "マイクを準備しています", listening: "どうぞ、お話しください", hearing: "お話を聞いています",
  transcribing: "お話を確かめています", thinking: "回答を準備しています", speaking: "AIがお話ししています", ended: "おつかれさまでした", error: "音声を開始できませんでした"
};

export function VoiceChat() {
  const [config, setConfig] = useState<VoiceConfiguration | null>(null);
  const [configurationError, setConfigurationError] = useState(false);
  const [supported, setSupported] = useState(true);
  const [state, setState] = useState(initialVoiceSnapshot);
  const [retry, setRetry] = useState(0);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const session = useRef<VoiceSession | null>(null), mounted = useRef(false), log = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mounted.current = true; setSupported(supportsVoice());
    const hide = () => { if (document.visibilityState === "hidden") session.current?.close("画面を離れたため、マイクと再生を停止しました。再開すると新しい面談になります。"); };
    const leave = () => session.current?.close();
    document.addEventListener("visibilitychange", hide); window.addEventListener("pagehide", leave);
    return () => {
      mounted.current = false; session.current?.close();
      document.removeEventListener("visibilitychange", hide); window.removeEventListener("pagehide", leave);
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); setConfigurationError(false);
    void fetch("/api/voice/config", { signal: controller.signal, cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error("configuration_unavailable");
      const value: VoiceConfiguration = await response.json();
      if (typeof value.enabled !== "boolean" || value.enabled && (typeof value.processors !== "string" || typeof value.voiceName !== "string"
        || !Number.isFinite(value.maxRecordingSeconds) || value.maxRecordingSeconds <= 0 || !Number.isFinite(value.maxAudioBytes) || value.maxAudioBytes < 44)) throw new Error("invalid_configuration");
      if (!controller.signal.aborted) setConfig(value);
    }).catch(() => { if (!controller.signal.aborted) setConfigurationError(true); });
    return () => controller.abort();
  }, [retry]);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [state.messages, showDiagnostics]);

  function start() {
    if (!config?.enabled || state.active) return;
    session.current?.close();
    const current = new VoiceSession(config, snapshot => { if (mounted.current && session.current === current) setState(snapshot); });
    session.current = current; void current.start();
  }

  return <section className="voice-panel" aria-label="音声AI面談">
    <div className="voice-panel-top"><span><span className={`status-dot ${state.active ? "voice-mic-on" : "voice-mic-off"}`} aria-hidden="true" />{state.phase === "starting" ? "マイク許可を確認中" : state.active ? "マイク使用中" : "マイク停止中"}</span>{state.active ? <button className="quiet-button" onClick={() => session.current?.close()}>面談を終了</button> : <span>標準の合成音声</span>}</div>
    <AnswerDiagnosticsSwitch enabled={showDiagnostics} onChange={setShowDiagnostics} />
    {!config && !configurationError ? <div className="voice-welcome"><p role="status">音声の設定を確認しています…</p></div>
      : configurationError ? <div className="voice-welcome"><h2>音声に接続できませんでした</h2><p role="alert">少し待って、もう一度お試しください。</p><button className="primary-button" onClick={() => setRetry(value => value + 1)}>接続をやり直す</button><a className="text-link" href="/">文字で話す</a></div>
      : !config?.enabled ? <div className="voice-welcome"><h2>音声面談は準備中です</h2><p>いまは、文字での面談をご利用いただけます。</p><a className="primary-button" href="/">文字で話す <span aria-hidden="true">→</span></a></div>
      : !supported ? <div className="voice-welcome"><h2>このブラウザーでは<br />音声を利用できません</h2><p>マイクに対応したブラウザーから、HTTPSのページを開いてください。</p><a className="primary-button" href="/">文字で話す</a></div>
      : <>
        <div className={`voice-stage voice-stage-${state.phase}`}>
          <div className="voice-symbol" aria-hidden="true"><span /><span /><span /><span /><span /></div>
          <h2 aria-live="polite">{labels[state.phase]}</h2>
          {state.notice && <p className="voice-notice" role="status">{state.notice}</p>}
          {state.error && <p role="alert" className="error-message">{state.error}</p>}
          {!state.active && <>
            <p className="voice-description">開始するとマイクを使用します。音声の文字起こし・回答生成・読み上げのため、{config.processors}へ音声や発言・必要な承認済み情報を送ります。</p>
            <p className="voice-description">本人の声を再現しない、標準の合成音声です。このアプリは録音・文字起こし・会話を保存しません。処理先での取り扱いは<a href="/about">このAIについて</a>をご確認ください。</p>
            <button className="primary-button" onClick={start}>{state.phase === "idle" ? "音声面談をはじめる" : "もう一度はじめる"}<span aria-hidden="true">→</span></button>
          </>}
          {state.active && <div className="voice-controls">
            <button className="primary-button" disabled={!state.recording} onClick={() => void session.current?.sendRecording()}>発言を送る <span aria-hidden="true">↑</span></button>
            <button className="voice-stop-button" disabled={!state.answering} onClick={() => session.current?.stopAnswer()}>回答を止める</button>
          </div>}
          {state.active && <p className="voice-hint">話し終えると自動で送信します。1回の発言は最大{Math.min(30, config.maxRecordingSeconds)}秒です。<br />聞き取りが不安定な場合は、イヤホンをお試しください。</p>}
        </div>
        {state.active && <>
          <div className="voice-transcript" ref={log} role="log" aria-label="音声の会話履歴" aria-live="polite" aria-relevant="additions text">
            {!state.messages.length ? <p className="voice-empty">聞き取った発言と回答が、ここに表示されます。</p> : state.messages.map(message => <article className={`message message-${message.role}`} key={message.id}>
              <span className="speaker">{message.role === "user" ? "あなた" : "AI面談くん"}</span>
              <p>{message.content || (state.answering && message.id === state.messages.at(-1)?.id ? "回答を準備しています…" : "回答は完了していません。")}</p>
              {showDiagnostics && message.role === "assistant" && message.complete && <AnswerDiagnosticsValue percent={message.retrievalSimilarityPercent} />}
              {!message.complete && message.content && (!state.answering || message.id !== state.messages.at(-1)?.id) && <small>回答は途中で終了しました。</small>}
            </article>)}
          </div>
          <div className="voice-session-bottom"><span>{state.ttfaMs !== null ? `声が届くまで ${(state.ttfaMs / 1000).toFixed(1)} 秒` : "会話はこの画面だけに保持します"}</span><span>標準の合成音声</span></div>
          <VoiceLatencyDetails samples={state.messages.flatMap(message => message.complete && message.latency ? [message.latency] : [])} />
        </>}
      </>}
  </section>;
}
