import { PublicError } from "../security/request.ts";
import { VOICE_MAX_SECONDS, VOICE_MAX_WAV_BYTES } from "./types.ts";

export function validateRecording(wav: Uint8Array): Uint8Array {
  const invalid = () => { throw new PublicError("INVALID_AUDIO", 400, "録音を確認して、もう一度お話しください。"); };
  if (wav.byteLength < 44 || wav.byteLength > VOICE_MAX_WAV_BYTES) return invalid();
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (offset: number) => String.fromCharCode(...wav.subarray(offset, offset + 4));
  // この画面の録音器が作るPCM16 mono WAVのみ受け取る。圧縮音声や任意ファイルを転送しない。
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || tag(12) !== "fmt " || tag(36) !== "data"
    || view.getUint32(4, true) !== wav.length - 8 || view.getUint32(16, true) !== 16
    || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1
    || view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16) return invalid();
  const rate = view.getUint32(24, true), size = view.getUint32(40, true);
  if (rate < 8000 || rate > 48000 || view.getUint32(28, true) !== rate * 2
    || size !== wav.length - 44 || size % 2 || size < rate * 2 * .15 || size > rate * 2 * VOICE_MAX_SECONDS) return invalid();
  return wav;
}

export async function readRecording(request: Request, signal: AbortSignal): Promise<Uint8Array> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "audio/wav")
    throw new PublicError("INVALID_AUDIO", 400, "音声形式を確認してください。");
  if (Number(request.headers.get("content-length") || 0) > VOICE_MAX_WAV_BYTES)
    throw new PublicError("AUDIO_TOO_LARGE", 413, "30秒以内でお話しください。");
  const reader = request.body?.getReader();
  if (!reader) throw new PublicError("INVALID_AUDIO", 400, "音声を録音してください。");
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > VOICE_MAX_WAV_BYTES) throw new PublicError("AUDIO_TOO_LARGE", 413, "30秒以内でお話しください。");
      chunks.push(next.value);
    }
    const wav = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { wav.set(chunk, offset); offset += chunk.length; }
    return validateRecording(wav);
  } finally { signal.removeEventListener("abort", cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
