import type { SpeechAudio } from "./types.ts";

const bytesPerSecond = 24_000 * 2;
const firstChunkBytes = bytesPerSecond / 4;
const chunkBytes = bytesPerSecond * 4;
const maxAnswerBytes = bytesPerSecond * 120;

function encode(bytes: Uint8Array): string {
  const pieces: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    pieces.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  return btoa(pieces.join(""));
}

// Providerのdelta数に依存せず、先頭250ms・以後4秒までのPCMへまとめる。
// 後続の送信回数を減らし、送信前の承認確認をD1のSQL予算内に収める。
export class SpeechChunks {
  private first = true;
  private received = 0;

  async *read(source: AsyncIterable<SpeechAudio>, signal: AbortSignal): AsyncGenerator<SpeechAudio> {
    let pending = new Uint8Array(this.first ? firstChunkBytes : chunkBytes), length = 0;
    const audio = (bytes: Uint8Array): SpeechAudio => ({ data: encode(bytes), mimeType: "audio/pcm", sampleRate: 24_000, channels: 1 });
    for await (const frame of source) {
      signal.throwIfAborted();
      if (frame.mimeType !== "audio/pcm" || frame.sampleRate !== 24_000 || frame.channels !== 1
        || typeof frame.data !== "string" || !frame.data.length || frame.data.length > 150_000
        || frame.data.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data))
        throw new Error("invalid_voice_audio");
      const binary = atob(frame.data);
      if (!binary.length || binary.length % 2 || btoa(binary) !== frame.data) throw new Error("invalid_voice_audio");
      this.received += binary.length;
      if (this.received > maxAnswerBytes) throw new Error("voice_answer_too_large");
      let offset = 0;
      while (offset < binary.length) {
        const count = Math.min(pending.length - length, binary.length - offset);
        for (let index = 0; index < count; index++) pending[length + index] = binary.charCodeAt(offset + index);
        length += count; offset += count;
        if (length === pending.length) {
          signal.throwIfAborted();
          this.first = false;
          yield audio(pending);
          pending = new Uint8Array(chunkBytes); length = 0;
        }
      }
    }
    signal.throwIfAborted();
    if (length) { this.first = false; yield audio(pending.subarray(0, length)); }
  }
}
