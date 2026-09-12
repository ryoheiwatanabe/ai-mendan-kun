import { readSse } from "../ai/sse.ts";
import { conversationReply } from "../answer/conversation.ts";
import type { Turn } from "../types.ts";
import type { VoiceConfiguration, VoiceEvent } from "./types.ts";
import { measureVoiceLatency, type VoiceLatency, type VoiceTimingMarks } from "./latency.ts";

type Phase = "idle" | "starting" | "listening" | "hearing" | "transcribing" | "thinking" | "speaking" | "ended" | "error";
const pausedNotice = "聞き取りをいったん止めました。再開ボタンを押してからお話しください。";
export type VoiceMessage = Turn & { id: string; complete: boolean; retrievalSimilarityPercent?: number | null; latency?: VoiceLatency };
export type VoiceSnapshot = {
  phase: Phase; active: boolean; recording: boolean; answering: boolean; listeningPaused: boolean;
  messages: VoiceMessage[]; error: string; notice: string; ttfaMs: number | null;
};
export const initialVoiceSnapshot = (): VoiceSnapshot => ({
  phase: "idle", active: false, recording: false, answering: false, listeningPaused: false, messages: [], error: "", notice: "", ttfaMs: null
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

// ブラウザーの収音レートから16kHzのmono PCM16 WAVへ変換する。録音は永続化しない。
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
  constructor(private context: AudioContext, private onFirst: (time: number) => void, private onEmpty: () => void) {}
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
      this.sources.add(source);
      // 受信済みPCMは同じ音声クロックへ連続予約し、片ごとの再生待ちによる隙間を作らない。
      const when = Math.max(this.nextStart, this.context.currentTime + .012);
      this.nextStart = when + buffer.duration;
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
  pause() { this.paused = true; void this.context.suspend().catch(() => {}); }
  async resume() {
    if (this.context.state === "closed") return;
    this.paused = false; await this.context.resume(); this.playNext();
  }
  async playFiller(bytes: ArrayBuffer, valid: () => boolean) {
    const buffer = await this.context.decodeAudioData(bytes);
    if (!valid() || this.pending || this.paused || this.context.state === "closed") return;
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.context.destination);
    this.filler = source;
    source.onended = () => { source.disconnect(); if (this.filler === source) this.filler = null; };
    source.start();
  }
  stopFiller() {
    const source = this.filler; this.filler = null;
    if (source) { source.onended = null; try { source.stop(); } catch {} source.disconnect(); }
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
  private preRoll: Float32Array[] = [];
  private sampleCount = 0;
  private pendingVoice = 0;
  private silence = 0;
  private lastVoiceAt = 0;
  private interruptedGeneration: number | null = null;
  private recognitionFailures = 0;
  constructor(private config: VoiceConfiguration, private update: (state: VoiceSnapshot) => void) {}
  private set(patch: Partial<VoiceSnapshot>) {
    this.state = { ...this.state, ...patch, answering: !!this.answer || !!this.transcription };
    if (this.state.listeningPaused) this.state.notice = pausedNotice;
    this.update(this.state);
  }
  async start() {
    this.set({ phase: "starting", active: true, error: "" });
    try {
      if (!supportsVoice()) throw new Error("unsupported");
      this.captureContext = new AudioContext(); this.outputContext = new AudioContext();
      // 再生の許可も開始ボタンのユーザー操作で取得する。
      const audioReady = Promise.all([this.captureContext.resume(), this.outputContext.resume()]).then(() => true, () => false);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true
      } });
      if (this.disposed) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      if (!await audioReady) throw new Error("audio_unavailable");
      await this.captureContext.audioWorklet.addModule("/audio-capture.js");
      if (this.disposed) return;
      this.player = new AudioQueue(this.outputContext, time => {
        if (!this.answer || this.disposed) return;
        this.answer.spoke = true;
        this.answer.timing.playedAt = time;
        this.set({ ttfaMs: Math.max(0, Math.round(time - this.answer.endedAt)), phase: this.state.recording ? "hearing" : "speaking" });
      }, () => this.settle());
      const source = this.captureContext.createMediaStreamSource(stream), worklet = new AudioWorkletNode(this.captureContext, "voice-capture");
      const muted = this.captureContext.createGain(); muted.gain.value = 0;
      source.connect(worklet); worklet.connect(muted); muted.connect(this.captureContext.destination);
      this.nodes = [source, worklet, muted]; this.worklet = worklet;
      worklet.port.onmessage = event => {
        if (event.data instanceof Float32Array) this.capture(event.data);
      };
      worklet.onprocessorerror = () => { if (!this.disposed) this.close("音声の収録が止まったため終了しました。もう一度開始できます。"); };
      for (const track of stream.getTracks()) track.addEventListener("ended", () => {
        if (!this.disposed) this.close("マイクとの接続が切れたため終了しました。もう一度開始できます。");
      }, { once: true });
      this.set({ phase: "listening", notice: "マイクに向かって、気になることを聞いてください。" });
    } catch (error) {
      if (this.disposed) return;
      this.close();
      this.set({ phase: "error", error: error instanceof DOMException && error.name === "NotAllowedError"
        ? "マイクを使用できませんでした。ブラウザーのマイク権限を許可して、もう一度開始してください。"
        : "音声を開始できませんでした。マイクの接続とブラウザーを確認して、もう一度お試しください。" });
    }
  }
  private capture(part: Float32Array) {
    if (this.disposed || !this.captureContext || this.transcription || this.state.listeningPaused) return;
    const rate = this.captureContext.sampleRate;
    const voiced = Math.sqrt(part.reduce((sum, value) => sum + value * value, 0) / part.length) > .018;
    if (!this.state.recording) {
      this.preRoll.push(part);
      while (this.preRoll.reduce((sum, value) => sum + value.length, 0) > rate * .25) this.preRoll.shift();
      this.pendingVoice = voiced ? this.pendingVoice + part.length : 0;
      if (this.pendingVoice < rate * .1) return;
      this.samples = this.preRoll; this.preRoll = []; this.sampleCount = this.samples.reduce((sum, value) => sum + value.length, 0);
      this.silence = 0;
      this.interruptedGeneration = this.answer && (this.player?.pending || this.answer.spoke && !this.answer.networkDone) ? this.answer.generation : null;
      if (this.answer) { this.answer.interrupted = true; this.player?.pause(); }
      this.set({ phase: "hearing", recording: true, error: "", notice: "お話を聞いています。話し終えると自動で送信します。" });
    } else {
      this.samples.push(part); this.sampleCount += part.length;
    }
    this.silence = voiced ? 0 : this.silence + part.length;
    if (voiced) this.lastVoiceAt = performance.now();
    const seconds = Math.min(30, this.config.maxRecordingSeconds);
    if (this.silence >= rate * .7 || this.sampleCount >= rate * seconds) void this.sendRecording();
  }
  async sendRecording() {
    if (this.disposed || !this.state.recording || this.transcription || !this.captureContext) return;
    const submittedAt = performance.now();
    const samples = this.samples, endedAt = this.lastVoiceAt || submittedAt, interrupted = this.interruptedGeneration;
    this.resetCapture();
    const controller = new AbortController(); this.transcription = controller;
    this.set({ phase: "transcribing", recording: false, notice: "お話を文字にしています。" });
    const timeout = setTimeout(() => controller.abort(), 45_000);
    let limitReached = false;
    let publicFailure = "音声を聞き取れませんでした。短く区切って、もう一度お話しください。";
    try {
      const body = wav(samples, this.captureContext.sampleRate, Math.min(3_200_044, this.config.maxAudioBytes), Math.min(30, this.config.maxRecordingSeconds));
      const result: unknown = await abortable((async () => {
        const response = await fetch("/api/voice/transcribe", { method: "POST", headers: { "Content-Type": "audio/wav" }, body, signal: controller.signal });
        if (response.status === 429) {
          limitReached = true;
          publicFailure = "音声の利用回数の上限に達しました。時間をおいて、もう一度お試しください。";
        }
        if (!response.ok) throw new Error("transcription_failed");
        return response.json();
      })(), controller.signal);
      if (this.disposed) return;
      if (controller.signal.aborted) throw new Error("transcription_aborted");
      if (!result || typeof result !== "object" || !("text" in result) || typeof result.text !== "string") throw new Error("invalid_transcription");
      const text = result.text.trim(), noSpeech = !/[\p{L}\p{N}]/u.test(text);
      if (text.length > 1000) throw new Error("invalid_transcription");
      this.recognitionFailures = 0;
      const transcribedAt = performance.now();
      if (noSpeech || interrupted !== null && this.answer?.generation === interrupted && isBackchannel(text)) {
        const resumedAnswer = this.answer;
        await abortable(this.player?.resume() ?? Promise.resolve(), controller.signal);
        if (this.disposed || this.transcription !== controller) return;
        this.transcription = null;
        if (this.answer !== resumedAnswer) { this.set({}); return; }
        this.set({ phase: this.player?.pending ? "speaking" : this.answer ? "thinking" : "listening", error: "",
          notice: noSpeech ? this.answer ? "回答を続けます。" : "どうぞ、お話しください。" : "相槌を受け取り、回答を続けます。" });
        this.settle();
      } else {
        clearTimeout(timeout);
        this.transcription = null;
        await this.ask(text, { endedAt, submittedAt, transcribedAt, firstTextAt: null, firstAudioAt: null, playedAt: null });
      }
    } catch {
      if (this.transcription !== controller) return;
      if (!this.disposed) {
        this.transcription = null;
        const listeningPaused = limitReached || ++this.recognitionFailures >= 2;
        if (!this.answer) { this.cancelWaiting(); this.player?.stopFiller(); }
        void this.player?.resume().catch(() => {});
        this.set({ phase: this.player?.pending ? "speaking" : this.answer ? "thinking" : "listening", listeningPaused, error: publicFailure,
          notice: "" });
        this.settle();
      }
    } finally { clearTimeout(timeout); if (this.transcription === controller) this.transcription = null; }
  }
  resumeListening() {
    if (this.disposed || !this.state.listeningPaused) return;
    this.recognitionFailures = 0; this.resetCapture();
    this.set({ listeningPaused: false, error: "", notice: "どうぞ、お話しください。" });
  }
  private resetCapture() {
    this.samples = []; this.preRoll = []; this.sampleCount = 0; this.pendingVoice = 0; this.silence = 0; this.lastVoiceAt = 0; this.interruptedGeneration = null;
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
  private async ask(text: string, timing: VoiceTimingMarks) {
    const endedAt = timing.endedAt;
    this.cancelAnswer(!this.answer && !!this.waiting);
    const generation = this.generation;
    try {
      await abortable(this.player?.resume() ?? Promise.resolve(), AbortSignal.timeout(5000));
    } catch {
      if (!this.disposed && this.generation === generation)
        this.set({ phase: "listening", error: "音声の再生を再開できませんでした。もう一度お話しください。", notice: "" });
      return;
    }
    if (this.disposed || this.generation !== generation) return;
    const history = this.history(), messageId = crypto.randomUUID();
    const answer: Answer = { generation: ++this.generation, messageId, controller: new AbortController(), answerId: null,
      sequence: 0, networkDone: false, spoke: false, endedAt, timing, interrupted: false };
    this.answer = answer;
    this.set({ phase: "thinking", ttfaMs: null, error: "", notice: "本人が確認した情報をもとに、お答えします。", messages: [
      ...this.state.messages, { id: `${messageId}:user`, role: "user", content: text, complete: true }, { id: messageId, role: "assistant", content: "", complete: false }
    ] });
    // 意味が確定するまでは発声せず、挨拶だけなら検索の補助音声を挟まない。
    if (!conversationReply(text)) this.beginWaiting(performance.now());
    const timeout = setTimeout(() => answer.controller.abort(), 90_000);
    let done = false;
    let limitReached = false;
    let publicFailure = "回答を続けられませんでした。もう一度お話しください。";
    try {
      const response = await fetch("/api/voice/chat", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "meeting_text", message: text, history }), signal: answer.controller.signal });
      if (response.status === 429) {
        limitReached = true;
        publicFailure = "音声の利用回数の上限に達しました。時間をおいて、もう一度お試しください。";
      }
      if (!response.ok || !response.body) throw new Error("answer_failed");
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
        if (limitReached) this.resetCapture();
        this.set({ phase: limitReached ? "listening" : this.state.recording ? "hearing" : "listening", error: publicFailure, notice: "",
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
    this.answer = null; this.cancelWaiting(); this.player?.stopFiller();
    this.set({ phase: "listening", notice: "続けて、気になることをお話しください。", messages: this.state.messages.map(message =>
      message.id === answer.messageId ? { ...message, complete: true, ...(latency ? { latency } : {}) } : message) });
  }
  private cancelAnswer(keepWaiting = false) {
    const answer = this.answer; this.answer = null; this.generation++;
    answer?.controller.abort();
    if (!keepWaiting) this.cancelWaiting();
    this.player?.reset(keepWaiting);
  }
  stopAnswer() {
    this.transcription?.abort(); this.transcription = null;
    this.cancelAnswer();
    void this.player?.resume().catch(() => {});
    this.set({ phase: this.state.recording ? "hearing" : "listening", notice: "回答を止めました。続けてお話しください。" });
  }
  close(notice = "面談を終了しました。会話と録音は、この画面から消去しました。") {
    if (this.disposed) return;
    this.disposed = true; this.transcription?.abort(); this.transcription = null; this.cancelAnswer(); this.resetCapture();
    if (this.worklet) { this.worklet.port.onmessage = null; this.worklet.port.close(); }
    this.nodes.forEach(node => node.disconnect()); this.nodes = [];
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    void this.captureContext?.close().catch(() => {}); void this.outputContext?.close().catch(() => {});
    this.set({ ...initialVoiceSnapshot(), phase: "ended", notice });
  }
}
