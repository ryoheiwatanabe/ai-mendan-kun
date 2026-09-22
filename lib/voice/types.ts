import type { ChatEvent } from "../types.ts";

export const VOICE_MAX_SECONDS = 30;
export const VOICE_MAX_WAV_BYTES = 3_200_044;

export type SpeechAudio = {
  data: string;
  mimeType: "audio/pcm";
  sampleRate: number;
  channels: 1;
};

export interface SpeechProvider {
  // vocabularyは、同意済みの公開用語だけを渡す（対応する提供元だけが使う）。
  transcribe(wav: Uint8Array, signal: AbortSignal, options?: { vocabulary?: string[] }): Promise<{ text: string }>;
  synthesize(text: string, signal: AbortSignal): AsyncIterable<SpeechAudio>;
}

export type VoiceEvent = ChatEvent | (SpeechAudio & {
  type: "audio";
  answerId: string;
  sequence: number;
}) | VoiceInputEvent;

// 理解した質問の通知。回答より先に1回だけ送る。
// 非表示対象のときは原文を渡さず（rawは空）、質問はマスク済みの文だけにする。
export type VoiceInputEvent = {
  type: "input-normalized";
  question: string;
  resolution: string;
  edited: boolean;
  blocked: boolean;
  // 重大な曖昧さで、回答を始めずに短い確認を出す状態。
  confirm: boolean;
  raw: string;
  notice?: string;
};

export type VoiceConfiguration = {
  enabled: boolean;
  // 読み上げ（発話）を行うか。falseは音声入力だけを使い、TTSを呼ばない。
  speak: boolean;
  processors: string;
  speechProvider: string;
  voiceName: string;
  maxRecordingSeconds: number;
  maxAudioBytes: number;
  // 読み上げの速さ。1が標準で、1.2なら2割速い（音の高さも上がる）。
  playbackRate: number;
  // ブラウザー認識の語彙ブーストに使う、公開承認済みの名称（対応環境だけ使う）。
  phrases?: string[];
};
