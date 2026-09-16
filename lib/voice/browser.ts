import { SpeechDetector } from "./speech-detector.ts";
import { readSse } from "../ai/sse.ts";
import { conversationReply } from "../answer/conversation.ts";
import type { Turn } from "../types.ts";
import type { VoiceConfiguration, VoiceEvent } from "./types.ts";
import { measureVoiceLatency, type VoiceLatency, type VoiceTimingMarks } from "./latency.ts";
import { markTestRecordingFailed, recordingFetch, recordTestEvent, startTestMicrophoneCapture } from "../test-recording.ts";
import { createRecognizer } from "./input/index.ts";
import { recognitionConstructor } from "./input/probe.ts";
import type { InputRecognizer, RecognitionFailure, RecognitionMode } from "./input/types.ts";

type Phase = "idle" | "starting" | "listening" | "hearing" | "transcribing" | "thinking" | "speaking" | "ended" | "error";
const pausedNotice = "聞き取りをいったん止めました。再開ボタンを押してからお話しください。";
export type VoiceMessage = Turn & { id: string; complete: boolean; retrievalSimilarityPercent?: number | null; latency?: VoiceLatency };
export type VoiceSnapshot = {
  phase: Phase; active: boolean; recording: boolean; manualRecording: boolean; answering: boolean; listeningPaused: boolean;
  manualSend: boolean; manualInput: boolean; recognitionMode: RecognitionMode | null; failedMode: RecognitionMode | null;
  interim: string; setupMs: number | null; microphone: string;
  messages: VoiceMessage[]; error: string; notice: string; ttfaMs: number | null;
  // 次に鳴らす音声が無く、続きの生成を待っている状態。文ごとに音声を作るため間が空く。
  audioWaiting: boolean;
};
export const initialVoiceSnapshot = (mode: RecognitionMode | null = null): VoiceSnapshot => ({
  phase: "idle", active: false, recording: false, manualRecording: false, answering: false, listeningPaused: false,
  manualSend: false, manualInput: mode === "manual", recognitionMode: mode, failedMode: null, interim: "", setupMs: null,
  microphone: "",
  messages: [], error: "", notice: "", ttfaMs: null
  , audioWaiting: false
});
export function supportsVoice() {
  return window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === "function"
    && typeof window.AudioContext === "function" && typeof window.AudioWorkletNode === "function";
}
function isBackchannel(text: string) {
  return /^((?:はい){1,3}|(?:うん){1,3}|ええ|なるほど|そうですね|そうなんですね|そうですか|わかりました|分かりました|了解です|ふむ|へえ|へぇ)[、。,.！!？?\s]*$/u.test(text.trim());
}

// fetchや音声APIが中断後も完了しない場合に、古い待機を画面へ残さない。
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

// ブラウザーの収音レートから16kHzのmono PCM16 WAVへ変換する。
function wav(samples: Float32Array[], sourceRate: number, maxBytes: number, maxSeconds: number): ArrayBuffer {
  const length = Math.min(samples.reduce((sum, part) => sum + part.length, 0), Math.floor(sourceRate * maxSeconds));
  const source = new Float32Array(length);
  let offset = 0;
  for (const part of samples) { const section = part.subarray(0, length - offset); source.set(section, offset); offset += section.length; }
  const frames = Math.floor(length * 16_000 / sourceRate);
  if (!frames || frames * 2 + 44 > maxBytes) throw new Error("recording_limit");
  const buffer = new ArrayBuffer(44 + frames * 2), view = new DataView(buffer);
  const ascii = (at: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };
  ascii(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); ascii(8, "WAVE"); ascii(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, "data"); view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) {
    const start = Math.floor(i * sourceRate / 16_000), end = Math.max(start + 1, Math.floor((i + 1) * sourceRate / 16_000));
    let sample = 0;
    for (let j = start; j < end; j++) sample += source[j] || 0;
    sample = Math.max(-1, Math.min(1, sample / (end - start)));
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return buffer;
}

class AudioQueue {
  private buffers: AudioBuffer[] = [];
  private sources = new Set<AudioBufferSourceNode>();
  private filler: AudioBufferSourceNode | null = null;
  private frame = 0;
  private generation = 0;
  private first = true;
  private firstScheduled = false;
  private nextStart = 0;
  paused = false;
  constructor(private context: AudioContext, private onFirst: (time: number) => void, private onEmpty: () => void,
    private report: (type: string, data: Record<string, unknown>) => void, rate = 1) {
    // 読み上げ速度。1以外では音の高さも変わる（テープを速めるのと同じ）。
    this.rate = Math.max(0.5, Math.min(2, rate));
  }
  private rate: number;
  get pending() { return this.sources.size > 0 || this.buffers.length > 0; }
  enqueue(event: Extract<VoiceEvent, { type: "audio" }>) {
    if (event.mimeType !== "audio/pcm" || event.channels !== 1 || event.sampleRate !== 24_000
      || typeof event.data !== "string" || !event.data.length || event.data.length > 2_000_000) throw new Error("invalid_audio");
    const binary = atob(event.data);
    if (binary.length % 2) throw new Error("invalid_audio");
    if (Math.max(0, this.nextStart - this.context.currentTime) + this.buffers.reduce((sum, buffer) => sum + buffer.duration, 0)
      + binary.length / 48_000 > 300) throw new Error("audio_limit");
    const buffer = this.context.createBuffer(1, binary.length / 2, 24_000), values = buffer.getChannelData(0);
    for (let i = 0; i < values.length; i++) {
      const value = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
      values[i] = (value >= 32768 ? value - 65536 : value) / 32768;
    }
    this.stopFiller(); this.buffers.push(buffer); this.playNext();
  }
  private playNext() {
    if (this.paused || this.context.state === "closed") return;
    const generation = this.generation;
    for (const buffer of this.buffers.splice(0)) {
      const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.context.destination);
      source.playbackRate.value = this.rate;
      this.sources.add(source);
      // 受信済みPCMは同じ音声クロックへ連続予約し、片ごとの再生待ちによる隙間を作らない。
      const when = Math.max(this.nextStart, this.context.currentTime + .012);
      const duration = buffer.duration / this.rate;
      this.nextStart = when + duration;
      source.onended = () => {
        source.disconnect();
        if (generation !== this.generation) return;
        this.sources.delete(source);
        if (!this.pending) this.onEmpty();
      };
      source.start(when);
      if (!this.first || this.firstScheduled) continue;
      this.firstScheduled = true;
      // 到着時刻ではなく、出力デバイスへ最初のsampleが届く音声クロックで計測する。
      const check = () => {
        if (generation !== this.generation || !this.first) return;
        const stamp = this.context.getOutputTimestamp?.();
        const time = typeof stamp?.contextTime === "number" ? stamp.contextTime : this.context.currentTime - (this.context.outputLatency || 0);
        if (!this.paused && time >= when) {
          this.first = false;
          this.onFirst(stamp?.performanceTime ? stamp.performanceTime - (time - when) * 1000 : performance.now());
        } else this.frame = requestAnimationFrame(check);
      };
      this.frame = requestAnimationFrame(check);
    }
    if (!this.pending) this.onEmpty();
  }
  pause() { this.paused = true; this.report("playback-pause", { audioTime: this.context.currentTime }); void this.context.suspend().catch(() => {}); }
  async resume() {
    if (this.context.state === "closed") return;
    this.paused = false; await this.context.resume();
    // 再開を待つ間に続きの声が来た場合、遅いresumeで回答を再生しない。
    if (this.paused) { await this.context.suspend(); return; }
    this.report("playback-resume", { audioTime: this.context.currentTime });
    this.playNext();
  }
  async playFiller(bytes: ArrayBuffer, valid: () => boolean) {
    const buffer = await this.context.decodeAudioData(bytes);
    if (!valid() || this.pending || this.paused || this.context.state === "closed") return;
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.context.destination);
    this.filler = source;
    source.onended = () => { source.disconnect(); if (this.filler === source) this.filler = null; this.report("filler-end", { audioTime: this.context.currentTime }); };
    source.start();
    this.report("filler-start", { text: "確認します。", audioTime: this.context.currentTime });
  }
  stopFiller() {
    const source = this.filler; this.filler = null;
    if (source) { this.report("filler-stop", { audioTime: this.context.currentTime }); source.onended = null; try { source.stop(); } catch {} source.disconnect(); }
  }
  reset(keepFiller = false) {
    this.generation++; cancelAnimationFrame(this.frame); if (!keepFiller) this.stopFiller();
    this.buffers = []; this.first = true; this.firstScheduled = false; this.nextStart = 0;
    for (const source of this.sources) { source.onended = null; try { source.stop(); } catch {} source.disconnect(); }
    this.sources.clear();
  }
}

type Answer = { generation: number; messageId: string; controller: AbortController; answerId: string | null;
  sequence: number; networkDone: boolean; spoke: boolean; endedAt: number; timing: VoiceTimingMarks; interrupted: boolean };
type Waiting = { controller: AbortController; timer: ReturnType<typeof setTimeout> | null };

export class VoiceSession {
  private state = initialVoiceSnapshot();
  private disposed = false;
  private stream: MediaStream | null = null;
  private testCapture: { stop(): void } | null = null;
  private captureContext: AudioContext | null = null;
  private outputContext: AudioContext | null = null;
  private nodes: AudioNode[] = [];
  private worklet: AudioWorkletNode | null = null;
  private player: AudioQueue | null = null;
  private transcription: AbortController | null = null;
  private answer: Answer | null = null;
  private waiting: Waiting | null = null;
  private generation = 0;
  private samples: Float32Array[] = [];
  private sampleCount = 0;
  private sampleRate = 16_000;
  // 自動終端後も回答を確定するまでは保持し、再発話した区間だけを追記する。
  private captureSealed = false;
  private detector: SpeechDetector | null = null;
  private startup = new AbortController();
  private lastVoiceAt = 0;
  private interruptedGeneration: number | null = null;
  private recognitionFailures = 0;
  private answerFailures = 0;
  private recognizer: InputRecognizer | null = null;
  private utteranceId: string | null = null;
  // 読み上げ（TTS）を行うか。サーバー設定を既定にし、画面から切り替えられる。
  private speak = true;
  constructor(private config: VoiceConfiguration, private mode: RecognitionMode, private update: (state: VoiceSnapshot) => void) {
    this.state = initialVoiceSnapshot(mode);
    this.speak = config.speak !== false;
  }
  setSpeak(value: boolean) {
    this.speak = value;
    if (!value) this.player?.pause();
  }
  private set(patch: Partial<VoiceSnapshot>) {
    this.state = { ...this.state, ...patch, answering: !!this.answer || !!this.transcription };
    this.state.audioWaiting = this.waitingForAudio();
    if (this.state.listeningPaused) this.state.notice = pausedNotice;
    this.detector?.setEnabled(this.canCapture());
    recordTestEvent("voice-state", { phase: this.state.phase, active: this.state.active, recording: this.state.recording,
      notice: this.state.notice, error: this.state.error, ttfaMs: this.state.ttfaMs, answerId: this.answer?.answerId ?? null,
      timing: this.answer?.timing ?? null, messages: this.state.messages.slice(-2) });
    this.update(this.state);
  }

  // 次に鳴らす音声が手元に無く、続きの生成を待っている状態。
  // 文ごとに音声を作るため、前の文を読み終えてから次の音声が届くまで間が空く。
  private waitingForAudio(): boolean {
    const answer = this.answer;
    if (!answer || this.disposed || answer.networkDone) return false;
    if (this.player?.pending || this.player?.paused) return false;
    if (this.state.recording || this.transcription) return false;
    return true;
  }
  async start() {
    this.set({ phase: "starting", active: true, error: "" });
    const startedAt = performance.now();
    try {
      if (this.mode === "manual") { await this.startTypedInput(startedAt); return; }
      if (!supportsVoice()) throw new Error("unsupported");
      this.recognizer = this.createInputRecognizer();
      this.captureContext = new AudioContext(); this.outputContext = new AudioContext();
      // 再生の許可も開始ボタンのユーザー操作で取得する。
      const audioReady = Promise.all([this.captureContext.resume(), this.outputContext.resume()]).then(() => true, () => false);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true
      } });
      if (this.disposed) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      // マイク名は許可の後にだけ取れる。認識の場所とは別に、どのマイクを使っているかを示す。
      const microphone = ((stream.getAudioTracks?.() ?? []).at(0) ?? stream.getTracks()[0])?.label?.trim().slice(0, 60) ?? "";
      if (microphone) this.set({ microphone });
      // 検証用の録音は開発時の補助。保存に失敗しても面談は止めず、画面の検証記録の案内へ状態を出す。
      try {
        this.testCapture = await startTestMicrophoneCapture(stream, () => this.set({}));
      } catch { this.testCapture = null; markTestRecordingFailed(); }
      if (this.disposed) { this.testCapture?.stop(); this.testCapture = null; return; }
      const microphoneEnded = () => {
        if (!this.disposed) this.close("マイクとの接続が切れたため終了しました。もう一度開始できます。");
      };
      for (const track of stream.getTracks()) {
        track.addEventListener("ended", microphoneEnded, { once: true });
        if (track.readyState === "ended") microphoneEnded();
      }
      if (this.disposed) return;
      if (!await audioReady) throw new Error("audio_unavailable");
      if (this.disposed) return;
      this.player = this.createPlayer(this.outputContext);
      this.set({ notice: "声を聞き分ける準備をしています。初回は少し時間がかかります。" });
      const detector = new SpeechDetector({
        start: () => { if (this.canCapture()) this.beginRecording(); },
        end: (audio, endedAt, reason) => {
          if (!this.canCapture() || !this.state.recording) return;
          this.sampleRate = 16_000; this.appendSamples(audio); this.lastVoiceAt = endedAt;
          if (reason !== "silence") this.captureSealed = true;
          void this.submitRecording();
        },
        failure: () => { void this.onDetectorFailure(detector); }
      }, Math.min(30, this.config.maxRecordingSeconds));
      this.detector = detector;
      const timeout = setTimeout(() => this.startup.abort(), 20_000);
      try {
        await abortable(detector.start(this.captureContext, stream, this.startup.signal), this.startup.signal);
      } catch {
        detector.close();
        if (!this.disposed) await this.onDetectorFailure(detector);
      } finally { clearTimeout(timeout); }
      if (this.disposed) return;
      // 発話を検知してからエンジンを起動すると最初の語が間に合わないため、待機中から動かす。
      try { this.recognizer?.listen(); } catch { this.onRecognitionFailure("unknown", true); }
      this.set({ phase: "listening", setupMs: Math.round(performance.now() - startedAt),
        notice: this.state.manualRecording ? "自動の聞き取りを利用できないため、録音ボタンでお話しください。"
          : this.state.manualSend ? "自動の聞き分けを利用できないため、話し終えたら「発言を送る」を押してください。"
          : "マイクに向かって、気になることを聞いてください。" });
    } catch (error) {
      if (this.disposed) return;
      this.close();
      this.set({ phase: "error", error: error instanceof DOMException && error.name === "NotAllowedError"
        ? "マイクを使用できませんでした。ブラウザーのマイク権限を許可して、もう一度開始してください。"
        : "音声を開始できませんでした。マイクの接続とブラウザーを確認して、もう一度お試しください。" });
    }
  }
  private createInputRecognizer(): InputRecognizer | null {
    if (this.mode === "manual") return null;
    return createRecognizer(this.mode, {
      constructor: recognitionConstructor(),
      callbacks: {
        interim: (utteranceId, text) => this.onInterim(utteranceId, text),
        failure: (reason, fatal) => this.onRecognitionFailure(reason, fatal)
      }
    });
  }
  private createPlayer(context: AudioContext) {
    return new AudioQueue(context, time => {
      if (!this.answer || this.disposed) return;
      this.answer.spoke = true;
      this.answer.timing.playedAt = time;
      recordTestEvent("playback-first", { answerId: this.answer.answerId, time, audioTime: this.outputContext?.currentTime });
      this.set({ ttfaMs: Math.max(0, Math.round(time - this.answer.endedAt)), phase: this.state.recording ? "hearing" : "speaking" });
    }, () => {
      recordTestEvent("playback-empty", { answerId: this.answer?.answerId ?? null, time: performance.now() });
      this.settle();
      // 読み終えて次の音声を待つ状態を画面へ伝える。ここで更新しないと生成中の表示が出ない。
      this.set({});
    },
    (type, data) => recordTestEvent(type, { ...data, answerId: this.answer?.answerId ?? null }), this.config.playbackRate);
  }
  // 手入力。マイクを開かず、入力した文字だけを回答の生成へ渡す。
  private async startTypedInput(startedAt: number) {
    if (!window.isSecureContext || typeof window.AudioContext !== "function") throw new Error("unsupported");
    this.outputContext = new AudioContext();
    const audioReady = this.outputContext.resume().then(() => true, () => false);
    if (!await audioReady) throw new Error("audio_unavailable");
    if (this.disposed) return;
    this.player = this.createPlayer(this.outputContext);
    this.set({ phase: "listening", manualInput: true, setupMs: Math.round(performance.now() - startedAt),
      notice: "質問を入力して「送る」を押してください。音声は送りません。" });
  }
  // 発話の開始。認識器へ発話IDを渡し、遅れて届く古い結果を識別する。
  private beginListening() {
    if (!this.recognizer || this.disposed || this.utteranceId) return;
    const utteranceId = crypto.randomUUID();
    this.utteranceId = utteranceId;
    this.set({ interim: "" });
    try { this.recognizer.listen(); this.recognizer.begin(utteranceId); }
    catch { this.onRecognitionFailure("unknown", true); }
  }
  private onInterim(utteranceId: string, text: string) {
    if (this.disposed || utteranceId !== this.utteranceId) return;
    // 回答の再生中に拾った声は、こちらの発話として表示しない。
    if (!this.state.recording && !this.state.manualSend) return;
    this.set({ interim: text });
  }
  private onRecognitionFailure(reason: RecognitionFailure, fatal: boolean) {
    if (this.disposed) return;
    recordTestEvent("recognition-failure", { reason, fatal, mode: this.mode });
    if (!fatal) return;
    // 黙って別の方式へ切り替えない。理由を示して終了し、利用者に選び直してもらう。
    const message = reason === "not-allowed" || reason === "audio-capture"
      ? "マイクを使用できませんでした。ブラウザーのマイク権限を確認して、もう一度お試しください。"
      : reason === "language-unavailable"
        ? "この端末では日本語の端末内認識を利用できません。別の方式を選んでください。"
      : reason === "network"
          ? "音声認識の接続が切れました。通信を確認し、別の方式も選べます。"
          : "音声認識を続けられませんでした。別の方式を選んでください。";
    this.close(message);
    // 面談の完了と同じ画面にしない。理由を示し、方式を選び直せる状態へ戻す。
    this.set({ phase: "error", error: message, notice: "", failedMode: this.mode });
  }
  private async onDetectorFailure(detector: SpeechDetector) {
    if (this.disposed) return;
    if (this.recognizer && !this.recognizer.needsAudio) {
      // 認識器が自分で聞き続けられる場合は、発話の区切りだけ利用者へ任せる。
      detector.close();
      if (this.detector === detector) this.detector = null;
      this.beginListening();
      this.set({ manualSend: true, recording: false, phase: "listening", setupMs: this.state.setupMs,
        notice: "自動の聞き分けを利用できないため、話し終えたら「発言を送る」を押してください。" });
      return;
    }
    await this.useManualRecording();
  }
  // 入力した文字を、音声と同じ回答の流れへ渡す。
  async submitTypedText(text: string) {
    const message = text.trim();
    if (this.disposed || !this.state.manualInput || this.state.answering || !message || message.length > 1000) return;
    const now = performance.now();
    const controller = new AbortController();
    this.transcription = controller;
    try {
      await this.ask(message, { endedAt: now, submittedAt: now, transcribedAt: now, firstTextAt: null, firstAudioAt: null, playedAt: null }, controller);
    } finally { if (this.transcription === controller) this.transcription = null; }
  }
  private canCapture() {
    const needsSamples = this.recognizer ? this.recognizer.needsAudio : true;
    return !this.disposed && !!this.captureContext && !this.state.listeningPaused
      && (!this.transcription || !this.state.manualRecording && !this.captureSealed && (!needsSamples || this.samples.length > 0));
  }
  private async useManualRecording() {
    if (this.disposed || this.state.manualRecording || !this.captureContext || !this.stream) return;
    this.detector?.close(); this.detector = null; this.discardRecording();
    this.set({ manualRecording: true, recording: false, phase: "starting" });
    void this.player?.resume().catch(() => {});
    try {
      await this.captureContext.audioWorklet.addModule("/audio-capture.js");
      if (this.disposed) return;
      const source = this.captureContext.createMediaStreamSource(this.stream), worklet = new AudioWorkletNode(this.captureContext, "voice-capture");
      const muted = this.captureContext.createGain(); muted.gain.value = 0;
      source.connect(worklet); worklet.connect(muted); muted.connect(this.captureContext.destination);
      this.nodes = [source, worklet, muted]; this.worklet = worklet;
      worklet.port.onmessage = event => { if (event.data instanceof Float32Array) this.capture(event.data); };
      worklet.onprocessorerror = () => { if (!this.disposed) this.close("音声の収録が止まったため終了しました。もう一度開始できます。"); };
      this.set({ phase: this.player?.pending ? "speaking" : this.answer ? "thinking" : "listening", notice: "自動の聞き取りを利用できないため、録音ボタンでお話しください。" });
    } catch { this.close("音声の収録を開始できませんでした。マイクの接続を確認して、もう一度開始してください。"); }
  }
  startRecording() {
    if (this.canCapture() && this.state.manualRecording && this.worklet && !this.state.recording) this.beginRecording();
  }
  private beginRecording() {
    if (this.state.recording) return;
    if (this.samples.length && !this.captureSealed) {
      // 文字起こしの待機中に続きが来た。旧結果を先に無効化してから中断する。
      const previous = this.transcription; this.transcription = null; previous?.abort();
    } else {
      this.resetCapture();
      this.interruptedGeneration = this.answer && (this.player?.pending || this.answer.spoke && !this.answer.networkDone) ? this.answer.generation : null;
    }
    if (this.answer) { this.answer.interrupted = true; this.player?.pause(); }
    this.beginListening();
    this.set({ phase: "hearing", recording: true, error: "", interim: "",
      notice: this.state.manualRecording ? "お話を聞いています。終わったら「発言を送る」を押してください。" : "お話を聞いています。話し終えると自動で送信します。" });
  }
  private capture(part: Float32Array) {
    if (!this.canCapture() || !this.state.manualRecording || !this.state.recording) return;
    this.sampleRate = this.captureContext!.sampleRate;
    this.appendSamples(part); this.lastVoiceAt = performance.now();
    if (this.captureSealed) void this.submitRecording();
  }
  async sendRecording() {
    if (this.disposed || !this.captureContext || this.state.listeningPaused) return;
    // 自動の聞き分けが使えない方式では、ボタンだけで発話を確定する。
    if (this.state.manualSend) { this.captureSealed = true; await this.submitRecording(true); return; }
    if (!this.state.recording) return;
    this.captureSealed = true;
    if (this.detector) this.detector.flush(); else await this.submitRecording();
  }
  private async submitRecording(forced = false) {
    const recognizer = this.recognizer;
    if (!recognizer || this.transcription) return;
    if (!forced && (!this.canCapture() || !this.state.recording)) return;
    // WAVを送る方式だけ、録音済みのPCMを要求する。
    if (recognizer.needsAudio && !this.samples.length) return;
    const submittedAt = performance.now();
    const samples = this.samples, sampleRate = this.sampleRate, endedAt = this.lastVoiceAt || submittedAt, interrupted = this.interruptedGeneration;
    const utteranceId = this.utteranceId ?? "";
    if (this.state.manualRecording) this.captureSealed = true;
    const controller = new AbortController(); this.transcription = controller;
    this.set({ phase: "transcribing", recording: false, notice: "お話を文字にしています。", interim: "" });
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 45_000);
    let timedOut = false;
    let limitReached = false;
    let publicFailure = "音声を聞き取れませんでした。短く区切って、もう一度お話しください。";
    try {
      const body = recognizer.needsAudio
        ? wav(samples, sampleRate, Math.min(3_200_044, this.config.maxAudioBytes), Math.min(30, this.config.maxRecordingSeconds))
        : null;
      const text = (await abortable(recognizer.finish(utteranceId, body, controller.signal), controller.signal)).trim();
      if (this.disposed || this.transcription !== controller) return;
      if (controller.signal.aborted) throw new Error("transcription_aborted");
      if (text.length > 1000) throw new Error("invalid_transcription");
      // この発話の文字起こしは受け取った。IDを残すと、次に話し始めたときの beginListening が
      // 働かず、認識器へ前の発話IDのままfinishを呼んで古い発話として失敗する。
      if (this.utteranceId === utteranceId) this.utteranceId = null;
      const noSpeech = !/[\p{L}\p{N}]/u.test(text);
      this.recognitionFailures = 0;
      const transcribedAt = performance.now();
      recordTestEvent("recognition-complete", { mode: this.mode, location: recognizer.location, utteranceId,
        textLength: text.length, endToTextMs: Math.round(transcribedAt - endedAt) });
      if (noSpeech || interrupted !== null && this.answer?.generation === interrupted && isBackchannel(text)) {
        const resumedAnswer = this.answer;
        await abortable(this.player?.resume() ?? Promise.resolve(), controller.signal);
        if (this.disposed || this.transcription !== controller) return;
        this.transcription = null; this.resetCapture();
        if (this.answer !== resumedAnswer) { this.set({}); return; }
        this.set({ phase: this.player?.pending ? "speaking" : this.answer ? "thinking" : "listening", error: "",
          notice: noSpeech ? this.answer ? "回答を続けます。" : "どうぞ、お話しください。" : "相槌を受け取り、回答を続けます。" });
        this.settle();
      } else {
        clearTimeout(timeout);
        await this.ask(text, { endedAt, submittedAt, transcribedAt, firstTextAt: null, firstAudioAt: null, playedAt: null }, controller);
      }
    } catch (error) {
      if (this.transcription !== controller) return;
      // 送信の取り消しや新しい発話の開始で自分から中断した場合は、失敗として表示しない。
      if (controller.signal.aborted && !timedOut) { this.discardRecording(); return; }
      const reason = error instanceof Error ? error.message : "";
      if (reason === "transcription_limit") {
        limitReached = true;
        publicFailure = "音声の利用回数の上限に達しました。時間をおいて、もう一度お試しください。";
      }
      if (!this.disposed) {
        this.discardRecording();
        const listeningPaused = limitReached || ++this.recognitionFailures >= 2;
        if (!this.answer) { this.cancelWaiting(); this.player?.stopFiller(); }
        void this.player?.resume().catch(() => {});
        this.set({ phase: this.player?.pending ? "speaking" : this.answer ? "thinking" : "listening", recording: false, listeningPaused, error: publicFailure,
          notice: "" });
        this.settle();
      }
    } finally { clearTimeout(timeout); if (this.transcription === controller) this.transcription = null; }
  }
  resumeListening() {
    if (this.disposed || !this.state.listeningPaused) return;
    this.recognitionFailures = 0; this.resetCapture();
    try { this.recognizer?.listen(); } catch { this.onRecognitionFailure("unknown", true); }
    this.set({ listeningPaused: false, error: "", notice: "どうぞ、お話しください。" });
  }
  private resetCapture() {
    this.samples = []; this.sampleCount = 0; this.lastVoiceAt = 0; this.interruptedGeneration = null; this.captureSealed = false;
    this.detector?.setRemainingSamples(16_000 * Math.min(30, this.config.maxRecordingSeconds));
  }
  private appendSamples(part: Float32Array) {
    const remaining = Math.max(0, Math.floor(this.sampleRate * Math.min(30, this.config.maxRecordingSeconds)) - this.sampleCount);
    const kept = part.length > remaining ? part.slice(0, remaining) : part;
    if (kept.length) { this.samples.push(kept); this.sampleCount += kept.length; }
    if (kept.length === remaining) this.captureSealed = true;
    this.detector?.setRemainingSamples(Math.max(0, remaining - kept.length));
  }
  private discardRecording() {
    const controller = this.transcription; this.transcription = null; controller?.abort();
    // 送信しない破棄。遅れて届く同じ発話の結果は認識器側で無視する。
    if (this.recognizer && this.utteranceId) this.recognizer.discard(this.utteranceId);
    this.utteranceId = null;
    this.detector?.setEnabled(false); this.resetCapture();
  }
  private history(): Turn[] {
    const history: Turn[] = [];
    for (let index = 0; index + 1 < this.state.messages.length; index++) {
      const user = this.state.messages[index], assistant = this.state.messages[index + 1];
      if (user.role === "user" && assistant.role === "assistant" && assistant.complete && assistant.content.trim())
        history.push({ role: "user", content: user.content }, { role: "assistant", content: assistant.content });
    }
    while (history.length > 12 || history.reduce((sum, turn) => sum + turn.content.length, 0) > 5500) history.splice(0, 2);
    return history;
  }
  private async ask(text: string, timing: VoiceTimingMarks, transcription: AbortController) {
    const endedAt = timing.endedAt;
    this.cancelAnswer(!this.answer && !!this.waiting);
    const generation = this.generation;
    try {
      await abortable(this.player?.resume() ?? Promise.resolve(), AbortSignal.any([transcription.signal, AbortSignal.timeout(5000)]));
    } catch {
      if (!this.disposed && this.generation === generation && this.transcription === transcription) {
        this.discardRecording();
        this.set({ phase: "listening", error: "音声の再生を再開できませんでした。もう一度お話しください。", notice: "" });
      }
      return;
    }
    if (this.disposed || this.generation !== generation || this.transcription !== transcription) return;
    this.transcription = null; this.resetCapture();
    const history = this.history(), messageId = crypto.randomUUID();
    const answer: Answer = { generation: ++this.generation, messageId, controller: new AbortController(), answerId: null,
      sequence: 0, networkDone: false, spoke: false, endedAt, timing, interrupted: false };
    this.answer = answer;
    this.set({ phase: "thinking", ttfaMs: null, error: "", notice: "本人が確認した情報をもとに、お答えします。", messages: [
      ...this.state.messages, { id: `${messageId}:user`, role: "user", content: text, complete: true }, { id: messageId, role: "assistant", content: "", complete: false }
    ] });
    // 意味が確定するまでは発声せず、挨拶だけなら検索の補助音声を挟まない。
    if (!this.state.manualInput && !conversationReply(text)) this.beginWaiting(performance.now());
    const timeout = setTimeout(() => answer.controller.abort(), 90_000);
    let done = false;
    let limitReached = false;
    let failureKind: "engine" | "transport" | "limit" = "engine";
    let publicFailure = "回答を続けられませんでした。もう一度お話しください。";
    try {
      const response = await recordingFetch("/api/voice/chat", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "meeting_text", message: text, history, speak: this.speak }), signal: answer.controller.signal });
      if (response.status === 429) {
        limitReached = true;
        failureKind = "limit";
        publicFailure = "音声の利用回数の上限に達しました。時間をおいて、もう一度お試しください。";
      }
      // 429は利用上限の案内を優先する。それ以外の失敗は接続・サーバー側の問題として扱う。
      if (!response.ok || !response.body) { if (!limitReached) failureKind = "transport"; throw new Error("answer_failed"); }
      for await (const raw of readSse(response.body, answer.controller.signal, 300_000)) {
        if (this.answer !== answer || this.disposed) return;
        const event = JSON.parse(raw) as VoiceEvent;
        if (event.type === "error") {
          if (event.code === "VOICE_ANSWER_LIMIT") publicFailure = "回答が長くなったため中断しました。質問を分けてお話しください。";
          throw new Error("answer_failed");
        }
        if (event.type === "start") {
          if (answer.answerId !== null || typeof event.answerId !== "string") throw new Error("invalid_event");
          answer.answerId = event.answerId;
        } else if (event.type === "text" || event.type === "audio" || event.type === "done") {
          if (!answer.answerId || event.answerId !== answer.answerId || done) throw new Error("invalid_event");
          if (event.type === "text") {
            if (typeof event.text !== "string") throw new Error("invalid_event");
            if ((this.state.messages.find(message => message.id === messageId)?.content.length ?? 0) + event.text.length > 6000) throw new Error("answer_limit");
            if (event.text.length) this.answerFailures = 0;
            if (event.text.length && answer.timing.firstTextAt === null) answer.timing.firstTextAt = performance.now();
            this.set({ messages: this.state.messages.map(message => message.id === messageId ? { ...message, content: message.content + event.text } : message) });
          }
          if (event.type === "audio") {
            if (event.sequence !== answer.sequence++) throw new Error("invalid_audio_order");
            if (answer.timing.firstAudioAt === null) answer.timing.firstAudioAt = performance.now();
            this.cancelWaiting();
            this.player?.enqueue(event);
            if (!this.state.recording && !this.transcription) this.set({ phase: "speaking", notice: "途中で話しかけることもできます。" });
          }
          if (event.type === "done") {
            done = true;
            this.set({ messages: this.state.messages.map(message => message.id === messageId ? { ...message, retrievalSimilarityPercent: event.retrievalSimilarityPercent } : message) });
          }
        }
      }
      if (this.answer !== answer || this.disposed) return;
      if (!done) throw new Error("incomplete_answer");
      answer.networkDone = true; this.settle();
    } catch {
      if (this.answer === answer && !this.disposed) {
        this.cancelAnswer();
        if (limitReached) this.discardRecording();
        // 同じ失敗を繰り返すときに、同じ言い方で試し続けさせない。
        const message = failureKind === "transport" ? "回答を作れませんでした。少し時間をおいて、もう一度お試しください。" : publicFailure;
        this.answerFailures = limitReached ? 0 : this.answerFailures + 1;
        const hint = !limitReached && this.answerFailures >= 2 ? " 繰り返す場合は、画面を再読み込みしてください。" : "";
        this.set({ phase: limitReached ? "listening" : this.state.recording ? "hearing" : "listening", error: `${message}${hint}`, notice: "",
          ...(limitReached ? { listeningPaused: true, recording: false } : {}) });
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  private beginWaiting(endedAt: number) {
    this.cancelWaiting();
    const waiting: Waiting = { controller: new AbortController(), timer: null }; this.waiting = waiting;
    waiting.timer = setTimeout(() => { void this.filler(waiting); }, Math.max(0, 900 - (performance.now() - endedAt)));
  }
  private cancelWaiting() {
    const waiting = this.waiting; this.waiting = null;
    if (waiting) { waiting.controller.abort(); if (waiting.timer) clearTimeout(waiting.timer); }
  }
  private async filler(waiting: Waiting) {
    const valid = () => !this.disposed && this.waiting === waiting && !this.answer?.spoke && !this.state.recording;
    if (!valid()) return;
    try {
      const response = await fetch("/audio/checking.wav", { signal: waiting.controller.signal });
      if (response.ok && valid()) await this.player?.playFiller(await response.arrayBuffer(), valid);
    } catch { /* 補助音声がなくても、回答を待ち続けられる。 */ }
  }
  private settle() {
    const answer = this.answer;
    if (!answer || !answer.networkDone || this.player?.pending || this.player?.paused || this.transcription || this.state.recording) return;
    const latency = answer.interrupted ? null : measureVoiceLatency(answer.timing);
    recordTestEvent("turn-complete", { answerId: answer.answerId, messageId: answer.messageId, timing: answer.timing, latency, interrupted: answer.interrupted });
    this.answer = null; this.cancelWaiting(); this.player?.stopFiller();
    this.set({ phase: "listening", notice: "続けて、気になることをお話しください。", messages: this.state.messages.map(message =>
      message.id === answer.messageId ? { ...message, complete: true, ...(latency ? { latency } : {}) } : message) });
    // 自動の聞き分けが使えない方式では、次の発話もボタンで区切る。
    if (this.state.manualSend) this.beginListening();
    // 次の発話の頭から聞こえるよう、待機中は認識エンジンを動かしておく。
    else { try { this.recognizer?.listen(); } catch { this.onRecognitionFailure("unknown", true); } }
  }
  private cancelAnswer(keepWaiting = false) {
    if (this.answer) recordTestEvent("playback-cancel", { answerId: this.answer.answerId, messageId: this.answer.messageId,
      time: performance.now(), audioTime: this.outputContext?.currentTime, timing: this.answer.timing });
    const answer = this.answer; this.answer = null; this.generation++;
    answer?.controller.abort();
    if (!keepWaiting) this.cancelWaiting();
    this.player?.reset(keepWaiting);
  }
  stopAnswer() {
    this.discardRecording();
    this.cancelAnswer();
    void this.player?.resume().catch(() => {});
    this.set({ phase: "listening", recording: false, notice: "回答を止めました。続けてお話しください。" });
  }
  close(notice = "面談を終了しました。会話と録音は、この画面から消去しました。") {
    if (this.disposed) return;
    this.disposed = true; this.startup.abort(); this.detector?.close(); this.detector = null; this.transcription?.abort(); this.transcription = null;
    this.recognizer?.close(); this.recognizer = null; this.utteranceId = null;
    this.cancelAnswer(); this.resetCapture();
    if (this.worklet) { this.worklet.port.onmessage = null; this.worklet.port.close(); }
    this.nodes.forEach(node => node.disconnect()); this.nodes = [];
    this.testCapture?.stop(); this.testCapture = null;
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    void this.captureContext?.close().catch(() => {}); void this.outputContext?.close().catch(() => {});
    this.set({ ...initialVoiceSnapshot(this.mode), phase: "ended", notice });
  }
}
