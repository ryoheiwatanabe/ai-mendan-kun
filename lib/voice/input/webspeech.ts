import type {
  InputRecognizer, RecognitionFailure, RecognitionLocation, RecognitionMode, RecognizerCallbacks,
  RecognitionResult, SpeechRecognitionConstructor, SpeechRecognitionErrorLike, SpeechRecognitionEventLike,
  SpeechRecognitionLike, SpeechRecognitionPhraseLike
} from "./types.ts";

// 停止操作の後に届く最後の確定結果を待つ上限。
const finishTimeoutMs = 1_500;
// 認識サービスが自動で切れた場合に、同じ待機として聞き直す回数。
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

// ブラウザーの音声認識を使う。認識エンジンは待機中から動かし、発話の区切りだけをVADに合わせる。
// 発話を検知してからstartすると、起動の待ち時間の分だけ最初の語が欠けるため。
// isFinalはその結果の確定であり質問全体の終わりではないので、複数の確定結果を発話として蓄積し、
// 無音判定や送信操作でfinishを呼んだ時に一度だけ返す。
export class WebSpeechRecognizer implements InputRecognizer {
  readonly mode: RecognitionMode;
  readonly location: RecognitionLocation;
  readonly needsAudio = false;
  private options: {
    mode: "on-device" | "browser-cloud"; constructor: SpeechRecognitionConstructor; callbacks: RecognizerCallbacks; restartLimit?: number;
    // 語彙ブースト（実験的）。対応する環境だけ使う。
    phrases?: string[]; phraseFactory?: (phrase: string, boost: number) => SpeechRecognitionPhraseLike;
  };
  private current: SpeechRecognitionLike | null = null;
  private listening = false;
  private utteranceId: string | null = null;
  // 前の認識セッションまでの確定結果と、今の認識セッションの結果。合計の並びは減らない。
  private historyFinals: string[] = [];
  private sessionFinals: string[] = [];
  // 確定結果ごとの代替候補。同じ順位を並べた発話全体だけを作り、組み合わせは作らない。
  private historyAlternatives: string[][] = [];
  private sessionAlternatives: string[][] = [];
  private sessionInterim = "";
  // 発話を始めた時点で確定済みだった結果数。これより前の文字は発話へ含めない。
  private baseline = 0;
  private restarts = 0;
  private closed = false;
  private completion: { resolve(result: RecognitionResult): void; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(options: {
    mode: "on-device" | "browser-cloud"; constructor: SpeechRecognitionConstructor; callbacks: RecognizerCallbacks; restartLimit?: number;
    phrases?: string[]; phraseFactory?: (phrase: string, boost: number) => SpeechRecognitionPhraseLike;
  }) {
    this.options = options;
    this.mode = options.mode;
    this.location = options.mode === "on-device" ? "device" : "external";
  }

  async prepare(): Promise<number> { return 0; }

  // 発話の前からエンジンを動かす。待機中に何度呼んでも増えない。
  listen(): void {
    if (this.closed || this.listening) return;
    this.listening = true;
    this.startRecognition();
  }

  begin(utteranceId: string): void {
    if (this.closed) return;
    this.listen();
    this.utteranceId = utteranceId;
    this.baseline = this.finals().length;
  }

  async finish(utteranceId: string, _wav: ArrayBuffer | null, signal: AbortSignal): Promise<RecognitionResult> {
    if (this.utteranceId !== utteranceId) throw new Error("stale_utterance");
    if (this.completion) return this.result();
    if (signal.aborted) throw signal.reason;
    const pending = new Promise<RecognitionResult>(resolve => {
      this.completion = { resolve, timer: setTimeout(() => this.settle(this.utteranceText()), finishTimeoutMs) };
    });
    // onendは認識サービスの切断通知なので送信の合図に使わない。停止後も最後の確定結果を待つ。
    try { this.current?.stop(); } catch {}
    return pending;
  }

  discard(utteranceId: string): void {
    if (this.utteranceId !== utteranceId) return;
    this.utteranceId = null;
    this.retireSession();
    this.stopRecognition();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const completion = this.completion; this.completion = null;
    this.utteranceId = null;
    this.stopRecognition();
    if (completion) { clearTimeout(completion.timer); completion.resolve({ text: "", alternatives: [] }); }
  }

  private finals(): string[] { return [...this.historyFinals, ...this.sessionFinals]; }
  private utteranceText(): string { return this.finals().slice(this.baseline).join("") + this.sessionInterim; }
  private result(): RecognitionResult { return { text: this.utteranceText(), alternatives: this.alternatives() }; }
  // 同じ順位の候補を並べる。1件しか返らない認識でも正常。confidence未取得は0点にしない。
  private alternatives(): string[] {
    const runs = [...this.historyAlternatives, ...this.sessionAlternatives].slice(this.baseline);
    // 返った候補の最大数まで（上限3）。1件だけの認識では1件のまま。
    const ranks = runs.length ? Math.max(1, Math.min(3, ...runs.map(run => run.length))) : 1;
    const output: string[] = [];
    for (let rank = 0; rank < ranks; rank++) output.push(runs.map(run => run[rank] ?? run[0] ?? "").join(""));
    return output.filter(value => value.trim().length > 0);
  }

  private startRecognition(): void {
    if (this.closed || !this.listening || this.current) return;
    const recognition = new this.options.constructor();
    // 端末内はprocessLocallyを明示する。指定しないとクラウドへ送られる場合がある。
    if (this.mode === "on-device") recognition.processLocally = true;
    recognition.lang = "ja-JP";
    recognition.continuous = true;
    recognition.interimResults = true;
    // 対応する環境では最大3件まで受け取り、実際に返った候補だけを使う。
    recognition.maxAlternatives = 3;
    // phrasesは実験的。機能検出できたときだけ、同意済みの公開用語を控えめに渡す。
    if (this.options.phrases?.length && this.options.phraseFactory) {
      try { recognition.phrases = this.options.phrases.slice(0, 20).map(phrase => this.options.phraseFactory!(phrase, 1)); }
      catch { /* 非対応・例外は従来動作へ戻す。起動条件にしない。 */ }
    }
    recognition.onresult = event => this.onResult(event);
    recognition.onerror = event => this.onError(event);
    recognition.onend = () => this.onEnd();
    this.current = recognition;
    try { recognition.start(); }
    catch (error) { this.options.callbacks.failure(failureOf(error), true); this.settle(this.utteranceText()); }
  }

  private onResult(event: SpeechRecognitionEventLike): void {
    if (this.closed || !this.listening) return;
    const finals: string[] = [];
    const alternatives: string[][] = [];
    let interim = "";
    const results = event?.results;
    // 毎回、そのセッションの結果一覧から作り直す。同じindexの確定結果を二重に数えない。
    for (let index = 0; results && index < results.length; index++) {
      const result = results[index];
      if (!result) continue;
      const transcript = result[0]?.transcript ?? "";
      if (result.isFinal) {
        finals.push(transcript);
        alternatives.push([...Array(Math.max(1, Math.min(3, result.length || 1)))].map((_, rank) => result[rank]?.transcript ?? ""));
      } else interim += transcript;
    }
    this.sessionFinals = finals; this.sessionInterim = interim; this.sessionAlternatives = alternatives;
    // 結果が届いている間は、自動再開の回数を数えない。
    this.restarts = 0;
    // 途中結果は表示だけに使い、ここでは回答AIへ送らない。発話を区切る前の文字は出さない。
    if (this.utteranceId) this.options.callbacks.interim(this.utteranceId, this.utteranceText());
  }

  private onError(event: SpeechRecognitionErrorLike): void {
    // 待機中の失敗は知らせるが、停止した後の遅着は無視する。
    if (this.closed || !this.listening) return;
    const reason = failureOf(event?.error);
    if (reason === "aborted") return;
    if (reason === "no-speech") { this.options.callbacks.failure(reason, false); return; }
    this.options.callbacks.failure(reason, true);
    this.settle(this.utteranceText());
  }

  private onEnd(): void {
    if (this.closed || !this.listening) return;
    if (this.completion) { this.settle(this.utteranceText()); return; }
    if (this.restarts >= (this.options.restartLimit ?? defaultRestartLimit)) {
      this.options.callbacks.failure("network", true);
      this.settle(this.utteranceText());
      return;
    }
    // 認識サービスが自動で切れた場合は、同じ待機のまま聞き直す。
    this.retireSession();
    this.current = null;
    this.restarts++;
    this.startRecognition();
  }

  private settle(text: string): void {
    const completion = this.completion; this.completion = null;
    this.utteranceId = null;
    const result = { text, alternatives: this.alternatives() };
    this.retireSession();
    this.stopRecognition();
    if (completion) { clearTimeout(completion.timer); completion.resolve(result); }
  }

  // 今のセッションの結果を、数え終わった結果として引き継ぐ。
  private retireSession(): void {
    this.historyFinals = [...this.historyFinals, ...this.sessionFinals];
    this.historyAlternatives = [...this.historyAlternatives, ...this.sessionAlternatives];
    this.sessionFinals = []; this.sessionInterim = ""; this.sessionAlternatives = [];
  }

  private stopRecognition(): void {
    const recognition = this.current; this.current = null;
    this.listening = false;
    if (!recognition) return;
    recognition.onresult = null; recognition.onerror = null; recognition.onend = null;
    try { recognition.abort(); } catch {}
  }
}
