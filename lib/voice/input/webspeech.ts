import type {
  InputRecognizer, RecognitionFailure, RecognitionLocation, RecognitionMode, RecognizerCallbacks,
  SpeechRecognitionConstructor, SpeechRecognitionErrorLike, SpeechRecognitionEventLike, SpeechRecognitionLike
} from "./types.ts";

// 停止操作の後に届く最後の確定結果を待つ上限。
const finishTimeoutMs = 1_500;
// 認識サービスが自動で切れた場合に、同じ発話として聞き直す回数。
const defaultRestartLimit = 3;

function failureOf(error: unknown): RecognitionFailure {
  const name = typeof error === "string" ? error : "";
  if (name === "not-allowed") return "not-allowed";
  if (name === "audio-capture") return "audio-capture";
  if (name === "language-not-supported") return "language-unavailable";
  if (name === "service-not-allowed") return "service-not-allowed";
  if (name === "network") return "network";
  if (name === "no-speech") return "no-speech";
  if (name === "aborted") return "aborted";
  return "unknown";
}

// ブラウザーの音声認識を使う。isFinalは「その結果が確定した」意味で、質問全体の終わりではない。
// 複数の確定結果は同じ発話として蓄積し、無音判定や送信操作でfinishを呼んだ時に一度だけ返す。
export class WebSpeechRecognizer implements InputRecognizer {
  readonly mode: RecognitionMode;
  readonly location: RecognitionLocation;
  readonly needsAudio = false;
  private current: SpeechRecognitionLike | null = null;
  private utteranceId: string | null = null;
  private committed: string[] = [];
  private liveFinals: string[] = [];
  private interim = "";
  private restarts = 0;
  private closed = false;
  private completion: { resolve(text: string): void; timer: ReturnType<typeof setTimeout> } | null = null;
  private options: { mode: "on-device" | "browser-cloud"; constructor: SpeechRecognitionConstructor; callbacks: RecognizerCallbacks; restartLimit?: number };

  constructor(options: { mode: "on-device" | "browser-cloud"; constructor: SpeechRecognitionConstructor; callbacks: RecognizerCallbacks; restartLimit?: number }) {
    this.options = options;
    this.mode = options.mode;
    this.location = options.mode === "on-device" ? "device" : "external";
  }

  async prepare(): Promise<number> { return 0; }

  begin(utteranceId: string): void {
    if (this.closed) return;
    this.stopRecognition();
    this.utteranceId = utteranceId;
    this.committed = []; this.liveFinals = []; this.interim = ""; this.restarts = 0;
    this.startRecognition();
  }

  async finish(utteranceId: string, _wav: ArrayBuffer | null, signal: AbortSignal): Promise<string> {
    if (this.utteranceId !== utteranceId) throw new Error("stale_utterance");
    if (this.completion) return this.text();
    if (signal.aborted) throw signal.reason;
    const pending = new Promise<string>(resolve => {
      this.completion = { resolve, timer: setTimeout(() => this.settle(this.text()), finishTimeoutMs) };
    });
    // onendは認識サービスの切断通知なので送信の合図に使わない。停止後も最後の確定結果を待つ。
    try { this.current?.stop(); } catch {}
    return pending;
  }

  discard(utteranceId: string): void {
    if (this.utteranceId !== utteranceId) return;
    this.utteranceId = null;
    this.committed = []; this.liveFinals = []; this.interim = "";
    this.stopRecognition();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const completion = this.completion; this.completion = null;
    this.utteranceId = null;
    this.stopRecognition();
    if (completion) { clearTimeout(completion.timer); completion.resolve(""); }
  }

  private text(): string { return `${[...this.committed, ...this.liveFinals].join("")}${this.interim}`.trim(); }

  private startRecognition(): void {
    if (this.closed || !this.utteranceId) return;
    const recognition = new this.options.constructor();
    // 端末内はprocessLocallyを明示する。指定しないとクラウドへ送られる場合がある。
    if (this.mode === "on-device") recognition.processLocally = true;
    recognition.lang = "ja-JP";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onresult = event => this.onResult(event);
    recognition.onerror = event => this.onError(event);
    recognition.onend = () => this.onEnd();
    this.current = recognition;
    try { recognition.start(); }
    catch (error) { this.options.callbacks.failure(failureOf(error), true); this.settle(this.text()); }
  }

  private onResult(event: SpeechRecognitionEventLike): void {
    if (!this.utteranceId || this.closed) return;
    const finals: string[] = [];
    let interim = "";
    const results = event?.results;
    // 毎回、その発話の結果一覧から作り直す。同じindexの確定結果を二重に数えない。
    for (let index = 0; results && index < results.length; index++) {
      const result = results[index];
      if (!result) continue;
      const transcript = result[0]?.transcript ?? "";
      if (result.isFinal) finals.push(transcript); else interim += transcript;
    }
    this.liveFinals = finals; this.interim = interim;
    // 途中結果は表示だけに使い、ここでは回答AIへ送らない。
    this.options.callbacks.interim(this.utteranceId, this.text());
  }

  private onError(event: SpeechRecognitionErrorLike): void {
    if (!this.utteranceId || this.closed) return;
    const reason = failureOf(event?.error);
    if (reason === "aborted") return;
    if (reason === "no-speech") { this.options.callbacks.failure(reason, false); return; }
    this.options.callbacks.failure(reason, true);
    this.settle(this.text());
  }

  private onEnd(): void {
    if (this.closed || !this.utteranceId) return;
    if (this.completion) { this.settle(this.text()); return; }
    if (this.restarts >= (this.options.restartLimit ?? defaultRestartLimit)) {
      this.options.callbacks.failure("network", true);
      this.settle(this.text());
      return;
    }
    // 認識サービスが自動で切れた場合は、同じ発話として聞き続ける。
    this.committed = [...this.committed, ...this.liveFinals];
    this.liveFinals = []; this.interim = "";
    this.restarts++;
    this.startRecognition();
  }

  private settle(text: string): void {
    const completion = this.completion; this.completion = null;
    this.utteranceId = null;
    this.stopRecognition();
    if (completion) { clearTimeout(completion.timer); completion.resolve(text); }
  }

  private stopRecognition(): void {
    const recognition = this.current; this.current = null;
    if (!recognition) return;
    recognition.onresult = null; recognition.onerror = null; recognition.onend = null;
    try { recognition.abort(); } catch {}
  }
}
