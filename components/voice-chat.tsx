"use client";

import { useEffect, useRef, useState } from "react";
import { initialVoiceSnapshot, supportsVoice, VoiceSession } from "../lib/voice/browser.ts";
import { detectRecognitionSupport, installJapanesePack, preferredMode, recognitionLabels, usableModes } from "../lib/voice/input/index.ts";
import type { RecognitionMode, RecognitionSupport } from "../lib/voice/input/types.ts";
import { browserSpeechProvider } from "../lib/voice/input/providers.ts";
import type { VoiceConfiguration } from "../lib/voice/types.ts";
import { conversationLabels, sendable } from "../lib/conversation.ts";
import { ConversationDiagnostics } from "./answer-diagnostics";
import { TestRecordingNotice, useTestRecording } from "./test-recording";
import { recordTestEvent } from "../lib/test-recording.ts";
import { AboutDialog } from "./about-dialog";

const labels = {
  idle: "音声で話す", starting: "マイクを準備しています", listening: "どうぞ、お話しください", hearing: "お話を聞いています",
  transcribing: "お話を確かめています", thinking: conversationLabels.thinking, speaking: "AIがお話ししています", ended: "おつかれさまでした", error: "音声を開始できませんでした"
};

export function VoiceChat() {
  const recording = useTestRecording();
  const [config, setConfig] = useState<VoiceConfiguration | null>(null);
  const [configurationError, setConfigurationError] = useState(false);
  // 読み上げのオン・オフ。音声の入口では既定オン。マイクの使用とは独立に切り替えられる。
  const [speak, setSpeak] = useState(true);
  const [supported, setSupported] = useState(true);
  const [support, setSupport] = useState<RecognitionSupport | null>(null);
  const [mode, setMode] = useState<RecognitionMode | null>(null);
  const [browserSpeech, setBrowserSpeech] = useState(() => browserSpeechProvider());
  const [pack, setPack] = useState<"idle" | "installing" | "installed" | "failed">("idle");
  const [typed, setTyped] = useState("");
  const follow = useRef(true);
  const [hasNew, setHasNew] = useState(false);
  const composing = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState(initialVoiceSnapshot);
  const [retry, setRetry] = useState(0);
  const inputProgress = state.recording ? (state.manualRecording ? "録音しています。お話しください…" : "声を検知しました。聞いています…")
    : state.phase === "transcribing" ? "お話を文字にしています…" : null;
  const lastMessage = state.messages.at(-1);
  // 最初の音声の前だけでなく、前の文を読み終えて次の音声を待つ間も生成中を示す。
  const preparingAudio = state.active && state.answering && state.audioWaiting
    && lastMessage?.role === "assistant" && !!lastMessage.content;
  const session = useRef<VoiceSession | null>(null), mounted = useRef(false), log = useRef<HTMLDivElement>(null);
  const serverAvailable = !!config?.enabled;
  // 保存された設定で読み上げが無効な場合、画面の希望と実際の可否が食い違うことを明示する。
  const speechAvailable = config?.speak !== false;
  const modes = support ? usableModes(support, serverAvailable) : [];
  // 一度失敗した方式も選び直せる。失敗の直後だけ、既定を別の方式へ移す。
  const fallbackModes = state.failedMode ? modes.filter(candidate => candidate !== state.failedMode) : modes;
  const selectedMode = mode && modes.includes(mode) ? mode : fallbackModes[0] ?? modes[0] ?? null;
  const activeMode = state.active ? state.recognitionMode : selectedMode;
  const modeLabels = { ...recognitionLabels, "browser-cloud": {
    ...recognitionLabels["browser-cloud"], location: browserSpeech.provider, note: browserSpeech.note
  } };
  const recognition = activeMode ? modeLabels[activeMode] : null;
  useEffect(() => {
    mounted.current = true; setSupported(supportsVoice());
    setBrowserSpeech(browserSpeechProvider(navigator));
    // 別のタブで調べ物をしても面談はそのまま続ける。閉じるときだけ面談を終える。
    const leave = () => session.current?.close();
    window.addEventListener("pagehide", leave);
    return () => {
      mounted.current = false; session.current?.close();
      window.removeEventListener("pagehide", leave);
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); setConfigurationError(false);
    void fetch("/api/voice/config", { signal: controller.signal, cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error("configuration_unavailable");
      const value: VoiceConfiguration = await response.json();
      if (typeof value.enabled !== "boolean" || value.enabled && (typeof value.processors !== "string" || typeof value.voiceName !== "string"
        || !Number.isFinite(value.maxRecordingSeconds) || value.maxRecordingSeconds <= 0 || !Number.isFinite(value.maxAudioBytes) || value.maxAudioBytes < 44
        || !Number.isFinite(value.playbackRate) || value.playbackRate < 0.5 || value.playbackRate > 2)) throw new Error("invalid_configuration");
      if (!controller.signal.aborted) { setConfig(value); setSpeak(value.speak !== false); }
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
  useEffect(() => {
    if (!log.current) return;
    if (follow.current) { log.current.scrollTop = log.current.scrollHeight; setHasNew(false); }
    else setHasNew(true);
  }, [state.messages, state.interim, inputProgress, preparingAudio]);
  useEffect(() => { if (state.active && state.manualInput && state.phase !== "starting") inputRef.current?.focus({ preventScroll: true }); }, [state.active, state.manualInput, state.phase === "starting"]);
  // 検証記録の保存が止まっても面談は続ける。状態は検証記録の案内(警告)で示す。

  // 方式を指定して開始する。マイクを使えないときの手入力への切り替えにも使う。
  function start(modeOverride?: RecognitionMode) {
    const chosen = modeOverride ?? selectedMode;
    if (!config?.enabled || !chosen || state.active || recording.enabled && !recording.healthy) return;
    if (modeOverride) setMode(modeOverride);
    follow.current = true; setHasNew(false);
    session.current?.close();
    const current = new VoiceSession(config, chosen, snapshot => { if (mounted.current && session.current === current) setState(snapshot); });
    session.current = current; current.setSpeak(speak); void current.start();
  }
  useEffect(() => {
    if (!state.failedMode) return;
    setMode(current => current === state.failedMode ? null : current);
  }, [state.failedMode]);
  // 言語パックの追加は利用者が押した時だけ行う。
  async function installPack() {
    setPack("installing");
    const outcome = await installJapanesePack();
    recordTestEvent("pack-install", { status: outcome.status, ...(outcome.error ? { error: outcome.error } : {}) });
    const value = await detectRecognitionSupport().catch(() => null);
    if (outcome.status === "installed" && value) { setSupport(value); setMode(preferredMode(value, serverAvailable, "on-device")); }
    setPack(outcome.status === "installed" ? "installed" : "failed");
  }
  // 準備中の言語パックが終わったかを、利用者の操作で確認する。
  async function recheckSupport() {
    const value = await detectRecognitionSupport().catch(() => null);
    if (!value) return;
    setSupport(value);
    setMode(current => preferredMode(value, serverAvailable, current));
  }
  function submitTyped(event: React.FormEvent) {
    event.preventDefault();
    const message = typed.trim();
    // 入力した文字は、音声で始めた会話でも同じ回答の流れへ渡す。
    if (composing.current || !sendable(message, { busy: state.answering })) return;
    follow.current = true;
    setTyped("");
    void session.current?.submitTypedText(message);
  }

  return <><section className={`voice-panel${state.active ? " voice-panel-active" : ""}`} aria-label="音声AI面談">
    <div className="voice-panel-top"><span><span className={`status-dot ${state.microphoneActive ? "voice-mic-on" : "voice-mic-off"}`} aria-hidden="true" />{state.microphoneActive ? state.phase === "starting" ? "音声を準備中（マイク接続中）" : state.listeningPaused ? "聞き取り停止中（マイク接続中）" : "マイク使用中" : state.phase === "starting" ? "音声を準備中" : state.active && state.manualInput ? "文字入力中（マイク不使用）" : "マイク停止中"}</span>{state.active ? <button className="quiet-button" onClick={() => { setTyped(""); setHasNew(false); session.current?.close(); }}>面談を終了</button> : <span>標準の合成音声</span>}</div>
    <p className="voice-hint">本人の承認済み情報をもとにAIが回答を生成しています。</p>
    <label className="voice-speak-toggle voice-speak-top"><input type="checkbox" checked={speak}
      onChange={event => { setSpeak(event.target.checked); session.current?.setSpeak(event.target.checked); }} />AIの読み上げ（オフは文字だけ）</label>
    {config && !speechAvailable && <p className="input-note" role="status">この環境では読み上げが無効のため、オンにしても音声は再生されません。回答の文字は表示されます。</p>}
    <TestRecordingNotice status={recording} />
    {!config && !configurationError ? <div className="voice-welcome"><p role="status">音声の設定を確認しています…</p></div>
      : configurationError ? <div className="voice-welcome"><h2>音声に接続できませんでした</h2><p role="alert">少し待って、もう一度お試しください。</p><button className="primary-button" onClick={() => setRetry(value => value + 1)}>接続をやり直す</button><a className="text-link" href="/">テキストで話す</a></div>
      : !config?.enabled ? <div className="voice-welcome"><h2>音声面談は準備中です</h2><p>いまは、テキストでの面談をご利用いただけます。</p><a className="primary-button" href="/">テキストで話す <span aria-hidden="true">→</span></a></div>
      : !supported ? <div className="voice-welcome"><h2>このブラウザーでは<br />音声を利用できません</h2><p>マイクに対応したブラウザーから、HTTPSのページを開いてください。テキストの面談は、このままご利用いただけます。</p><a className="primary-button" href="/">テキストで話す</a><button className="quiet-button" onClick={() => start("manual")} disabled={state.active}>文字入力で続ける</button></div>
      : <>
        <div className={`voice-stage voice-stage-${state.phase}`}>
          <div className="voice-symbol" aria-hidden="true"><span /><span /><span /><span /><span /></div>
          <h2 aria-live="polite">{state.listeningPaused ? "聞き取りを一時停止しています" : preparingAudio ? "音声を準備しています" : state.manualInput && state.phase === "listening" ? "質問を入力してください" : labels[state.phase]}</h2>
          {state.notice && <p className="voice-notice" role="status">{preparingAudio ? "表示した回答を音声にしています。" : state.notice}</p>}
          {state.error && <p role="alert" className="error-message">{state.error}</p>}
          {!state.active && <>
            <details className="voice-aux" open>
              <summary>音声認識の方法（{recognition ? recognition.name : "確認中"}）</summary>
              <fieldset className="voice-recognition">
                <legend>音声の文字起こし方法</legend>
                {!modes.length ? <p role="status">文字起こしの方法を確認しています…</p> : modes.map(candidate => <label key={candidate} className={`voice-recognition-item${candidate === selectedMode ? " selected" : ""}`}>
                  <input type="radio" name="voice-recognition-mode" value={candidate} checked={candidate === selectedMode} onChange={() => setMode(candidate)} />
                  <span className="voice-recognition-name">{modeLabels[candidate].name}</span>
                  <span className="voice-recognition-location">{candidate === "manual" ? "" : "処理先："}{modeLabels[candidate].location}</span>
                  <span className="voice-recognition-note">{modeLabels[candidate].note}</span>
                </label>)}
              </fieldset>
              {support?.onDevice === "downloading" && <div className="voice-pack">
                <p role="status">日本語の言語パックを準備しています。終わると「この端末で文字にする」を選べます。</p>
                <button className="quiet-button" onClick={recheckSupport}>準備できたか確認する</button>
              </div>}
              {support?.packInstallable && (support.onDevice === "downloadable" || pack === "installed") && <details className="voice-pack">
                <summary>端末内の音声認識を設定（任意）</summary>
                <p>{browserSpeech.packSource}{browserSpeech.packSourceUrl && <> · <a className="text-link" href={browserSpeech.packSourceUrl} target="_blank" rel="noopener noreferrer">Chromeの公式説明（英語・別タブ）</a></>}</p>
                <p>日本語の音声を端末内で文字にするための言語データを、ブラウザーの標準機能で追加します。このアプリから別のソフトをインストールする必要はありません。</p>
                {support.onDevice === "downloadable" && <p>{support.browserCloud !== "unavailable" ? "ブラウザー認識とGeminiは" : "Geminiは"}追加なしで使えます。音声を端末外へ送らない方式を選ぶ場合だけ追加してください。文字にした質問は回答AIへ送ります。</p>}
                <button className="quiet-button" onClick={installPack} disabled={pack === "installing" || pack === "installed"}>{pack === "installing" ? "言語パックを追加しています…" : "日本語の言語パックを追加する"}</button>
                {pack === "installed" && <p role="status">言語パックを追加しました。「この端末で文字にする」を選べます。</p>}
                {pack === "failed" && <p role="alert">言語パックを追加できませんでした。このブラウザーでは追加できない場合があります。上の一覧からほかの方法を選んでください。</p>}
              </details>}
            </details>
            <p className="voice-description">{activeMode === "manual"
              ? "マイクは使用せず、入力した文字を送ります。"
              : <>開始するとマイクを使用します。音声の文字起こし：{recognition?.location ?? "確認中"}。</>}
              質問・直近の会話・必要な公開承認済み情報を{config.processors}へ送り、回答を作成・確認します。{speak ? "確認した回答を読み上げます。" : "読み上げは行いません。"}</p>
            <div className="voice-description">本人の声を再現しない、標準の合成音声です。{recording.enabled ? "この検証画面では、会話と音声をこのMacへ保存します。" : "このアプリは録音・文字起こし・会話を保存しません。"}処理先での取り扱いは<AboutDialog processors={config.processors} voice={config} />をご確認ください。</div>
            <button className="primary-button" onClick={() => start()} disabled={!selectedMode || recording.enabled && !recording.healthy}>{state.phase === "idle" ? "音声面談をはじめる" : "もう一度はじめる"}<span aria-hidden="true">→</span></button>
            {state.phase === "error" && <button className="quiet-button" onClick={() => start("manual")}>マイクを使わず文字入力で続ける</button>}
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
            {!state.manualInput && !state.listeningPaused && <button className="voice-stop-button" onClick={() => session.current?.pauseListening()}>聞き取りを止める</button>}
            <button className="voice-stop-button" disabled={!state.answering} onClick={() => session.current?.stopAnswer()}>回答を止める</button>
          </div>}

        </div>
        {state.active && <>
          <div className="conversation-area voice-history"><div className="voice-transcript" ref={log} onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < 32; if (follow.current) setHasNew(false); }} role="log" aria-label="音声の会話履歴" aria-live="polite" aria-relevant="additions text">
            {!state.messages.length && !inputProgress && !state.interim && <p className="voice-empty">{state.manualInput ? "入力した質問と回答が、ここに表示されます。" : "聞き取った発言と回答が、ここに表示されます。"}</p>}
            {state.inputEdited && !state.inputBlocked && <p className="voice-edited" role="status">
              音声入力を整えました<small>聞き取った内容：{state.inputOriginal}</small>
              <button type="button" onClick={() => {
                // 戻ってきた質問を既存の入力欄へ入れて焦点を当てる。同じ質問を再修正しても戻る。
                const question = session.current?.editQuestion();
                if (question) { setTyped(question); inputRef.current?.focus(); }
              }}>質問を修正</button></p>}
            {state.messages.filter(message => message.role === "assistant" || message.content.trim())
              .map(message => <article className={`message message-${message.role}`} key={message.id}>
              <span className="speaker">{message.role === "user" ? "あなた" : "AI面談くん"}</span>
              <p>{message.content || (state.answering && message.id === state.messages.at(-1)?.id ? conversationLabels.thinking : conversationLabels.notCompleted)}</p>
              {preparingAudio && message.id === lastMessage?.id && <p className="voice-progress" role="status"><span className="voice-progress-spinner" aria-hidden="true" />音声を生成しています…</p>}
              {!message.complete && message.content && (!state.answering || message.id !== state.messages.at(-1)?.id) && <small>{conversationLabels.interrupted}</small>}
            </article>)}
            {state.interim
              ? <div className="message message-user voice-live-input"><span className="speaker">あなた</span>
                <p>{state.interim}<span className="voice-interim-note">まだ送信していません</span></p></div>
              : inputProgress && <div className="message message-user voice-live-input">
                <span className="speaker">あなた</span>
                <p className="voice-progress" role="status"><span className={state.recording ? "voice-progress-listening" : "voice-progress-spinner"} aria-hidden="true" />{inputProgress}</p>
              </div>}
          </div>{hasNew && <button type="button" className="new-messages" onClick={() => { follow.current = true; if (log.current) log.current.scrollTop = log.current.scrollHeight; setHasNew(false); }}>新しい回答へ ↓</button>}</div>
          <form className="voice-typed" onSubmit={submitTyped}>
            <label className="voice-typed-label" htmlFor="voice-typed-input">質問を入力</label>
            <input id="voice-typed-input" className="voice-typed-input" value={typed} maxLength={1000} autoComplete="off"
              ref={inputRef} onChange={event => setTyped(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current)) event.preventDefault(); }} disabled={!state.active} placeholder="例：チームでの担当範囲はどこまでですか。" />
            <button className="primary-button" type="submit" disabled={!state.active || !typed.trim() || state.answering}>送る <span aria-hidden="true">↑</span></button>
          </form>
          {state.active && <p className="voice-hint">{state.manualInput
            ? "入力した文字だけを回答の生成へ送ります。音声は送りません。"
            : state.manualRecording
              ? "録音を開始して話し、終わったら「発言を送る」を押してください。文字入力でも質問できます。1回の発言は最大" + Math.min(30, config.maxRecordingSeconds) + "秒です。"
            : state.manualSend
              ? "話し終えたら「発言を送る」を押してください。文字入力でも質問できます。1回の発言は最大" + Math.min(30, config.maxRecordingSeconds) + "秒です。"
              : "話し終えると自動で送信します。文字入力でも質問できます。1回の発言は最大" + Math.min(30, config.maxRecordingSeconds) + "秒です。"}{recognition && !state.manualInput ? "聞き取りが不安定な場合は、イヤホンをお試しください。" : ""}</p>}
        </>}
      </>}
  </section>
    <ConversationDiagnostics mode="voice" messages={state.messages} setupMs={state.setupMs}
      recognition={recognition ? `${recognition.location}（${recognition.name}）` : null}
      ttfaMs={state.ttfaMs} microphone={state.microphone} />
  </>;
}
