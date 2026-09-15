"use client";

import { useEffect, useRef, useState } from "react";
import { initialVoiceSnapshot, supportsVoice, VoiceSession } from "../lib/voice/browser.ts";
import { detectRecognitionSupport, installJapanesePack, preferredMode, recognitionLabels, usableModes } from "../lib/voice/input/index.ts";
import type { RecognitionMode, RecognitionSupport } from "../lib/voice/input/types.ts";
import type { VoiceConfiguration } from "../lib/voice/types.ts";
import { AnswerDiagnosticsSwitch, AnswerDiagnosticsValue } from "./answer-diagnostics";
import { VoiceLatencyDetails } from "./voice-latency";
import { TestRecordingNotice, useTestRecording } from "./test-recording";
import { recordTestEvent } from "../lib/test-recording.ts";

const labels = {
  idle: "声で、話してみませんか。", starting: "マイクを準備しています", listening: "どうぞ、お話しください", hearing: "お話を聞いています",
  transcribing: "お話を確かめています", thinking: "回答を準備しています", speaking: "AIがお話ししています", ended: "おつかれさまでした", error: "音声を開始できませんでした"
};

export function VoiceChat() {
  const recording = useTestRecording();
  const [config, setConfig] = useState<VoiceConfiguration | null>(null);
  const [configurationError, setConfigurationError] = useState(false);
  const [supported, setSupported] = useState(true);
  const [support, setSupport] = useState<RecognitionSupport | null>(null);
  const [mode, setMode] = useState<RecognitionMode | null>(null);
  const [pack, setPack] = useState<"idle" | "installing" | "installed" | "failed">("idle");
  const [typed, setTyped] = useState("");
  const [state, setState] = useState(initialVoiceSnapshot);
  const [retry, setRetry] = useState(0);
  const [showDiagnostics, setShowDiagnostics] = useState(true);
  const inputProgress = state.recording ? (state.manualRecording ? "録音しています。お話しください…" : "声を検知しました。聞いています…")
    : state.phase === "transcribing" ? "お話を文字にしています…" : null;
  const lastMessage = state.messages.at(-1);
  const preparingAudio = state.active && state.answering && !state.recording && state.phase !== "transcribing"
    && !state.listeningPaused && state.ttfaMs === null && lastMessage?.role === "assistant" && !!lastMessage.content;
  const session = useRef<VoiceSession | null>(null), mounted = useRef(false), log = useRef<HTMLDivElement>(null);
  const serverAvailable = !!config?.enabled;
  const modes = support ? usableModes(support, serverAvailable) : [];
  // 認識に失敗した方式は候補から外し、選択中のまま残さない。
  const selectable = state.failedMode ? modes.filter(candidate => candidate !== state.failedMode) : modes;
  const selectedMode = mode && selectable.includes(mode) ? mode : selectable[0] ?? null;
  const activeMode = state.recognitionMode ?? selectedMode;
  const recognition = activeMode ? recognitionLabels[activeMode] : null;
  // 音声を外部へ送るのは、ブラウザーのクラウド認識と、従来のサーバー認識のときだけ。
  const sendsAudio = activeMode === "server" || activeMode === "browser-cloud";
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
  // 方式はブラウザー名では決めない。APIの対応状況と日本語の利用可否を問い合わせる。
  useEffect(() => {
    if (!config?.enabled) return;
    let active = true;
    void detectRecognitionSupport().then(value => {
      if (!active) return;
      setSupport(value);
      setMode(current => preferredMode(value, true, current));
    }).catch(() => { if (active) setSupport({ onDevice: "unavailable", browserCloud: "unavailable", packInstallable: false }); });
    return () => { active = false; };
  }, [config?.enabled]);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [state.messages, state.interim, showDiagnostics, inputProgress, preparingAudio]);
  useEffect(() => {
    if (recording.enabled && !recording.healthy) session.current?.close("検証記録を保存できないため終了しました。保存先と接続を確認してください。");
  }, [recording.enabled, recording.healthy]);

  function start() {
    if (!config?.enabled || !selectedMode || state.active || recording.enabled && !recording.healthy) return;
    session.current?.close();
    const current = new VoiceSession(config, selectedMode, snapshot => { if (mounted.current && session.current === current) setState(snapshot); });
    session.current = current; void current.start();
  }
  // 言語パックの追加は利用者が押した時だけ行う。
  async function installPack() {
    setPack("installing");
    const result = await installJapanesePack();
    recordTestEvent("pack-install", { result });
    const value = await detectRecognitionSupport().catch(() => null);
    if (result === "installed" && value) { setSupport(value); setMode(preferredMode(value, serverAvailable, "on-device")); }
    setPack(result === "installed" ? "installed" : "failed");
  }
  function submitTyped(event: React.FormEvent) {
    event.preventDefault();
    const message = typed.trim();
    if (!message || state.answering) return;
    setTyped("");
    void session.current?.submitTypedText(message);
  }

  return <section className="voice-panel" aria-label="音声AI面談">
    <div className="voice-panel-top"><span><span className={`status-dot ${state.active ? "voice-mic-on" : "voice-mic-off"}`} aria-hidden="true" />{state.phase === "starting" ? "音声を準備中" : state.active ? "マイク使用中" : "マイク停止中"}</span>{state.active ? <button className="quiet-button" onClick={() => session.current?.close()}>面談を終了</button> : <span>標準の合成音声</span>}</div>
    <p className="voice-hint">本人の承認済み情報をもとにAIが回答を生成しています。</p>
    <AnswerDiagnosticsSwitch enabled={showDiagnostics} onChange={setShowDiagnostics} />
    <TestRecordingNotice status={recording} />
    {!config && !configurationError ? <div className="voice-welcome"><p role="status">音声の設定を確認しています…</p></div>
      : configurationError ? <div className="voice-welcome"><h2>音声に接続できませんでした</h2><p role="alert">少し待って、もう一度お試しください。</p><button className="primary-button" onClick={() => setRetry(value => value + 1)}>接続をやり直す</button><a className="text-link" href="/">文字で話す</a></div>
      : !config?.enabled ? <div className="voice-welcome"><h2>音声面談は準備中です</h2><p>いまは、文字での面談をご利用いただけます。</p><a className="primary-button" href="/">文字で話す <span aria-hidden="true">→</span></a></div>
      : !supported ? <div className="voice-welcome"><h2>このブラウザーでは<br />音声を利用できません</h2><p>マイクに対応したブラウザーから、HTTPSのページを開いてください。</p><a className="primary-button" href="/">文字で話す</a></div>
      : <>
        <div className={`voice-stage voice-stage-${state.phase}`}>
          <div className="voice-symbol" aria-hidden="true"><span /><span /><span /><span /><span /></div>
          <h2 aria-live="polite">{state.listeningPaused ? "聞き取りを一時停止しています" : preparingAudio ? "音声を準備しています" : labels[state.phase]}</h2>
          {state.notice && <p className="voice-notice" role="status">{preparingAudio ? "表示した回答を音声にしています。" : state.notice}</p>}
          {state.error && <p role="alert" className="error-message">{state.error}</p>}
          {!state.active && <>
            <fieldset className="voice-recognition">
              <legend>音声の文字起こし方法</legend>
              {!modes.length ? <p role="status">文字起こしの方法を確認しています…</p> : modes.map(candidate => <label key={candidate} className={`voice-recognition-item${candidate === selectedMode ? " selected" : ""}${candidate === state.failedMode ? " failed" : ""}`}>
                <input type="radio" name="voice-recognition-mode" value={candidate} checked={candidate === selectedMode} disabled={candidate === state.failedMode} onChange={() => setMode(candidate)} />
                <span className="voice-recognition-name">{recognitionLabels[candidate].name}</span>
                <span className="voice-recognition-location">処理場所：{recognitionLabels[candidate].location}</span>
                <span className="voice-recognition-note">{candidate === state.failedMode ? "この環境では認識できませんでした。ほかの方法を選んでください。" : recognitionLabels[candidate].note}</span>
              </label>)}
            </fieldset>
            {support?.packInstallable && (support.onDevice === "downloadable" || pack === "installed") && <div className="voice-pack">
              {support.onDevice === "downloadable" && <p>日本語の端末内認識を使うには、言語パックの追加ダウンロードが必要です。初回は数分かかることがあります。</p>}
              <button className="quiet-button" onClick={installPack} disabled={pack === "installing" || pack === "installed"}>{pack === "installing" ? "言語パックを追加しています…" : "日本語の言語パックを追加する"}</button>
              {pack === "installed" && <p role="status">言語パックを追加しました。「この端末で文字にする」を選べます。</p>}
              {pack === "failed" && <p role="alert">言語パックを追加できませんでした。このブラウザーでは追加できない場合があります。上の一覧からほかの方法を選んでください。</p>}
            </div>}
            <p className="voice-description">{sendsAudio
              ? <>開始するとマイクを使用します。音声の文字起こし・回答生成・読み上げのため、{config.processors}へ音声や発言・必要な承認済み情報を送ります。</>
              : <>開始するとマイクを使用します。音声認識は{recognition?.location === "端末内" ? "この端末の中" : "外部"}で行い{activeMode === "manual" ? "、音声は使いません" : "、音声は外部へ送りません"}。回答の生成と読み上げのため、文字にした質問と必要な承認済み情報を{config.processors}へ送ります。</>}</p>
            <p className="voice-description">本人の声を再現しない、標準の合成音声です。{recording.enabled ? "この検証画面では、会話と音声をこのMacへ保存します。" : "このアプリは録音・文字起こし・会話を保存しません。"}処理先での取り扱いは<a href="/about">このAIについて</a>をご確認ください。</p>
            <button className="primary-button" onClick={start} disabled={!selectedMode || recording.enabled && !recording.healthy}>{state.phase === "idle" ? "音声面談をはじめる" : "もう一度はじめる"}<span aria-hidden="true">→</span></button>
          </>}
          {state.active && <div className="voice-controls">
            {state.listeningPaused
              ? <button className="primary-button" onClick={() => session.current?.resumeListening()}>聞き取りを再開 <span aria-hidden="true">→</span></button>
              : state.manualInput ? null
              : state.manualSend
                ? <button className="primary-button" disabled={state.phase === "starting" || state.phase === "transcribing"} onClick={() => void session.current?.sendRecording()}>発言を送る <span aria-hidden="true">↑</span></button>
              : state.manualRecording && !state.recording
                ? <button className="primary-button" disabled={state.phase === "starting" || state.phase === "transcribing"} onClick={() => session.current?.startRecording()}>録音を開始 <span aria-hidden="true">●</span></button>
                : <button className="primary-button" disabled={!state.recording} onClick={() => void session.current?.sendRecording()}>発言を送る <span aria-hidden="true">↑</span></button>}
            <button className="voice-stop-button" disabled={!state.answering} onClick={() => session.current?.stopAnswer()}>回答を止める</button>
          </div>}
          {state.active && state.manualInput && <form className="voice-typed" onSubmit={submitTyped}>
            <label className="voice-typed-label" htmlFor="voice-typed-input">質問を入力</label>
            <input id="voice-typed-input" className="voice-typed-input" value={typed} maxLength={1000} autoComplete="off"
              onChange={event => setTyped(event.target.value)} disabled={state.answering} placeholder="例：チームでの担当範囲はどこまでですか。" />
            <button className="primary-button" type="submit" disabled={!typed.trim() || state.answering}>送る <span aria-hidden="true">↑</span></button>
          </form>}
          {state.active && <p className="voice-hint">{state.manualInput
            ? "入力した文字だけを回答の生成へ送ります。音声は送りません。"
            : state.manualRecording
              ? "録音を開始して話し、終わったら「発言を送る」を押してください。1回の発言は最大" + Math.min(30, config.maxRecordingSeconds) + "秒です。"
            : state.manualSend
              ? "話し終えたら「発言を送る」を押してください。1回の発言は最大" + Math.min(30, config.maxRecordingSeconds) + "秒です。"
              : "話し終えると自動で送信します。1回の発言は最大" + Math.min(30, config.maxRecordingSeconds) + "秒です。"}<br />{recognition ? `音声認識：${recognition.location}（${recognition.name}）` : ""}{recognition && !state.manualInput ? "。聞き取りが不安定な場合は、イヤホンをお試しください。" : ""}</p>}
        </div>
        {state.active && <>
          <div className="voice-transcript" ref={log} role="log" aria-label="音声の会話履歴" aria-live="polite" aria-relevant="additions text">
            {!state.messages.length && !inputProgress && !state.interim && <p className="voice-empty">{state.manualInput ? "入力した質問と回答が、ここに表示されます。" : "聞き取った発言と回答が、ここに表示されます。"}</p>}
            {state.messages.map(message => <article className={`message message-${message.role}`} key={message.id}>
              <span className="speaker">{message.role === "user" ? "あなた" : "AI面談くん"}</span>
              <p>{message.content || (state.answering && message.id === state.messages.at(-1)?.id ? "回答を準備しています…" : "回答は完了していません。")}</p>
              {preparingAudio && message.id === lastMessage?.id && <p className="voice-progress" role="status"><span className="voice-progress-spinner" aria-hidden="true" />音声を生成しています…</p>}
              {showDiagnostics && message.role === "assistant" && message.complete && <AnswerDiagnosticsValue percent={message.retrievalSimilarityPercent} />}
              {!message.complete && message.content && (!state.answering || message.id !== state.messages.at(-1)?.id) && <small>回答は途中で終了しました。</small>}
            </article>)}
            {state.interim
              ? <div className="message message-user voice-live-input"><span className="speaker">あなた</span>
                <p>{state.interim}<span className="voice-interim-note">まだ送信していません</span></p></div>
              : inputProgress && <div className="message message-user voice-live-input">
                <span className="speaker">あなた</span>
                <p className="voice-progress" role="status"><span className={state.recording ? "voice-progress-listening" : "voice-progress-spinner"} aria-hidden="true" />{inputProgress}</p>
              </div>}
          </div>
          <div className="voice-session-bottom"><span>{state.ttfaMs !== null ? `声が届くまで ${(state.ttfaMs / 1000).toFixed(1)} 秒` : recording.enabled ? "検証記録をこのMacに保存します" : "会話はこの画面だけに保持します"}</span><span>{recognition ? `音声認識：${recognition.location}` : "標準の合成音声"}</span></div>
          <VoiceLatencyDetails samples={state.messages.flatMap(message => message.complete && message.latency ? [message.latency] : [])}
            setupMs={state.setupMs} recognition={recognition ? `${recognition.location}（${recognition.name}）` : null} />
        </>}
      </>}
  </section>;
}
