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
  transcribe(wav: Uint8Array, signal: AbortSignal): Promise<{ text: string }>;
  synthesize(text: string, signal: AbortSignal): AsyncIterable<SpeechAudio>;
}

export type VoiceEvent = ChatEvent | (SpeechAudio & {
  type: "audio";
  answerId: string;
  sequence: number;
});

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
};
