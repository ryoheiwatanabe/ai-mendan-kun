// 入力側の音声認識。方式を差し替えても、発話の区切りと回答の流れは変えない。
export type RecognitionMode = "on-device" | "browser-cloud" | "server" | "manual";
export type RecognitionLocation = "device" | "external";
// available()が返す状態。確認できない環境はunknownとし、端末内とは扱わない。
export type RecognitionAvailability = "available" | "downloadable" | "downloading" | "unavailable" | "unknown";
export type RecognitionFailure =
  | "not-supported" | "not-allowed" | "audio-capture" | "language-unavailable" | "service-not-allowed"
  | "network" | "no-speech" | "aborted" | "unknown";

export type RecognitionSupport = {
  onDevice: RecognitionAvailability;
  browserCloud: RecognitionAvailability;
  packInstallable: boolean;
};

// 認識結果。本文と、実際に返った代替候補（対応する認識器だけ）。
// 候補は文字列の組み合わせを作らず、同じ順位の候補を並べた発話全体だけを持つ。
export type RecognitionResult = { text: string; alternatives: string[] };

export type RecognizerCallbacks = {
  // 発話中の途中結果。表示だけに使い、この時点では回答AIへ送らない。
  interim(utteranceId: string, text: string): void;
  // fatalは発話の継続が難しい失敗。fatalでない失敗は次の発話で回復できる。
  failure(reason: RecognitionFailure, fatal: boolean): void;
};

export interface InputRecognizer {
  readonly mode: RecognitionMode;
  readonly location: RecognitionLocation;
  /** 録音したPCMをWAVにして送る方式かどうか。 */
  readonly needsAudio: boolean;
  /** 初回の準備にかかった時間(ms)。言語パックの導入は利用者の操作で行う。 */
  prepare(signal: AbortSignal): Promise<number>;
  /** 認識エンジンを動かし続ける。発話の区切り(begin)より前に呼ぶ。 */
  listen(): void;
  /** 発話の開始。utteranceIdは呼び出し側が採番し、遅れて届く古い結果の識別に使う。 */
  begin(utteranceId: string): void;
  /** 発話の確定。needsAudioのときだけWAVを渡す。 */
  finish(utteranceId: string, wav: ArrayBuffer | null, signal: AbortSignal): Promise<RecognitionResult>;
  /** 送信しないで破棄する。以後に遅れて届く結果は無視する。 */
  discard(utteranceId: string): void;
  close(): void;
}

export const recognitionLabels: Record<RecognitionMode, { name: string; location: string; note: string }> = {
  "on-device": { name: "この端末で文字にする", location: "端末内",
    note: "音声を外部へ送りません。回答の生成には、文字にした質問を送ります。" },
  "browser-cloud": { name: "ブラウザーの音声認識を使う", location: "ブラウザー提供元（名称を確認できません）",
    note: "追加ダウンロードは不要です。音声がブラウザー提供元のサービスへ送信される場合があります。" },
  "server": { name: "Geminiの音声認識を使う", location: "Google（Gemini API）",
    note: "録音した音声をGoogleのGemini APIへ送って文字にします。追加ダウンロードは不要です。" },
  "manual": { name: "手入力で質問する", location: "音声認識なし（マイク不使用）",
    note: "音声を送りません。入力した文字だけを回答の生成へ送ります。" }
};

// Web Speech APIの最小構造。TSのDOM型にprocessLocally/available/installが無い場合があるため自前で定義する。
export type SpeechRecognitionAlternativeLike = { transcript: string };
export type SpeechRecognitionResultLike = {
  isFinal: boolean; length: number; [index: number]: SpeechRecognitionAlternativeLike;
};
export type SpeechRecognitionEventLike = {
  resultIndex: number; results: { length: number; [index: number]: SpeechRecognitionResultLike };
};
export type SpeechRecognitionErrorLike = { error: string };
// 実験的な語彙ブースト。未対応のブラウザーでは存在しないため、機能検出してから使う。
export type SpeechRecognitionPhraseLike = { phrase: string; boost?: number };
export type SpeechRecognitionLike = {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number; processLocally?: boolean;
  phrases?: SpeechRecognitionPhraseLike[];
  start(): void; stop(): void; abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorLike) => void) | null;
  onend: (() => void) | null;
};
export type SpeechRecognitionConstructor = {
  new (): SpeechRecognitionLike;
  available?: (options: { langs: string[]; processLocally?: boolean }) => Promise<string>;
  install?: (options: { langs: string[]; processLocally?: boolean }) => Promise<boolean>;
};
export type RecognitionScope = {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
  SpeechRecognitionPhrase?: new (phrase: string, boost?: number) => SpeechRecognitionPhraseLike;
};
