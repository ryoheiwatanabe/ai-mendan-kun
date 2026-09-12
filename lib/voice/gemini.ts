import { readSse } from "../ai/sse.ts";
import { VOICE_MAX_WAV_BYTES, type SpeechAudio, type SpeechProvider } from "./types.ts";

const endpoint = "https://generativelanguage.googleapis.com/v1beta/interactions";
const sampleRate = 24_000;
const sttMaxTokens = 512;
const ttsMaxTokens = 1024;
// TTSは25音声token/秒、24kHz・mono・16bit。API上限と受信量の両方で制限する。
const maxPcmBytes = ttsMaxTokens / 25 * sampleRate * 2;
const maxFrameChars = 150_000;

class SpeechError extends Error {}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function safeError(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted) return new Error("voice_provider_aborted");
  if (error instanceof Error && error.message === "stream_frame_too_large") return new Error("voice_response_too_large");
  return new Error(error instanceof SpeechError ? error.message : "voice_provider_error");
}
function textValue(value: unknown): string {
  if (typeof value !== "string") throw new SpeechError("invalid_voice_text");
  const text = value.trim();
  if (!text || text.length > 1000) throw new SpeechError("invalid_voice_text");
  return text;
}
function base64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  // 一度に引数へ展開しない。数MBの録音でも呼出しスタックの上限を超えない。
  for (let i = 0; i < bytes.length; i += 0x8000)
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  return btoa(chunks.join(""));
}
function boundedBody(body: ReadableStream<Uint8Array>, limit: number, signal: AbortSignal): ReadableStream<Uint8Array> {
  let received = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > limit) throw new SpeechError("voice_response_too_large");
      controller.enqueue(chunk);
    }
  }), { signal });
}
async function readJson(body: ReadableStream<Uint8Array>, signal: AbortSignal, byteLimit = 64_000): Promise<unknown> {
  const reader = boundedBody(body, byteLimit, signal).getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let json = "";
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      json += decoder.decode(next.value, { stream: true });
    }
    signal.throwIfAborted();
    return JSON.parse(json + decoder.decode());
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function completed(value: unknown, maxTokens: number): asserts value is Record<string, unknown> {
  if (!record(value) || value.status !== "completed") throw new SpeechError("voice_provider_incomplete");
  if (value.error != null || (value.errors != null && (!Array.isArray(value.errors) || value.errors.length)))
    throw new SpeechError("voice_provider_error");
  if (value.usage !== undefined) {
    if (!record(value.usage)) throw new SpeechError("invalid_voice_response");
    const output = value.usage.total_output_tokens;
    if (output !== undefined && (typeof output !== "number" || !Number.isSafeInteger(output) || output < 0 || output > maxTokens))
      throw new SpeechError("invalid_voice_usage");
  }
}

type AudioFormat = { mime?: string; rate?: number; channels?: number };
function audioChunk(value: unknown, format: AudioFormat): { audio?: SpeechAudio; bytes: number } {
  if (!record(value) || value.type !== "audio" || value.uri !== undefined)
    throw new SpeechError("invalid_voice_audio");
  if (value.mime_type !== undefined) {
    if (typeof value.mime_type !== "string") throw new SpeechError("unsupported_voice_audio");
    const [mime, ...parameters] = value.mime_type.toLowerCase().split(";").map(part => part.trim());
    if (mime !== "audio/l16") throw new SpeechError("unsupported_voice_audio");
    for (const parameter of parameters) {
      const pair = parameter.split("=").map(part => part.trim());
      const expected = { codec: "pcm", rate: "24000", channels: "1" }[pair[0]];
      const actual = pair[1]?.replace(/^"(.*)"$/, "$1");
      if (pair.length !== 2 || !expected || actual !== expected) throw new SpeechError("unsupported_voice_audio");
    }
    format.mime = "audio/l16";
  }
  if (value.sample_rate !== undefined) {
    if (value.sample_rate !== sampleRate) throw new SpeechError("unsupported_voice_audio");
    format.rate = sampleRate;
  }
  if (value.channels !== undefined) {
    if (value.channels !== 1) throw new SpeechError("unsupported_voice_audio");
    format.channels = 1;
  }
  if (value.data === undefined || value.data === "") return { bytes: 0 };
  if (format.mime !== "audio/l16" || format.rate !== sampleRate || format.channels !== 1)
    throw new SpeechError("unsupported_voice_audio");
  const data = value.data;
  if (typeof data !== "string" || data.length > maxFrameChars || data.length % 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))
    throw new SpeechError("invalid_voice_audio");
  const decoded = atob(data);
  // PCMのsampleを途中で切らず、非正規base64や異なる形式の先頭を受け付けない。
  if (!decoded.length || decoded.length % 2 || btoa(decoded) !== data
    || decoded.startsWith("RIFF") || decoded.startsWith("OggS") || decoded.startsWith("ID3"))
    throw new SpeechError("invalid_voice_audio");
  return { audio: { data, mimeType: "audio/pcm", sampleRate, channels: 1 }, bytes: decoded.length };
}

export class GeminiSpeechProvider implements SpeechProvider {
  private readonly key: string;
  readonly sttModel: string;
  readonly ttsModel: string;
  readonly voice: string;
  readonly ttsMode: "buffered" | "streaming";

  constructor(key: string, options: { sttModel?: string; ttsModel?: string; voice?: string; ttsMode?: "buffered" | "streaming" } = {}) {
    this.key = key;
    this.sttModel = options.sttModel ?? "gemini-3.5-transcribe";
    this.ttsModel = options.ttsModel ?? "gemini-3.1-flash-tts-preview";
    this.voice = options.voice ?? "Kore";
    this.ttsMode = options.ttsMode ?? "buffered";
  }

  private async request(body: Record<string, unknown>, signal: AbortSignal, streaming = false): Promise<ReadableStream<Uint8Array>> {
    signal.throwIfAborted();
    const response = await fetch(endpoint, {
      method: "POST", redirect: "manual", signal,
      headers: { "x-goog-api-key": this.key, "Content-Type": "application/json", Accept: streaming ? "text/event-stream" : "application/json" },
      body: JSON.stringify({ ...body, store: false })
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new SpeechError(`voice_http_${response.status}`);
    }
    const mime = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
    if (mime !== (streaming ? "text/event-stream" : "application/json")) {
      await response.body.cancel().catch(() => {});
      throw new SpeechError("invalid_voice_response");
    }
    return response.body;
  }

  async transcribe(wav: Uint8Array, signal: AbortSignal): Promise<{ text: string }> {
    try {
      signal.throwIfAborted();
      if (!(wav instanceof Uint8Array) || wav.byteLength < 44 || wav.byteLength > VOICE_MAX_WAV_BYTES
        || String.fromCharCode(...wav.subarray(0, 4)) !== "RIFF" || String.fromCharCode(...wav.subarray(8, 12)) !== "WAVE"
        || new DataView(wav.buffer, wav.byteOffset, wav.byteLength).getUint32(4, true) !== wav.byteLength - 8)
        throw new SpeechError("invalid_voice_recording");
      const body = await this.request({
        model: this.sttModel,
        input: [{ type: "audio", mime_type: "audio/wav", data: base64(wav) }],
        generation_config: { max_output_tokens: sttMaxTokens,
          transcription_config: { language_codes: ["ja-JP"], mode: { type: "verbatim" }, custom_vocabulary: ["AI"] } }
      }, signal);
      const result = await readJson(body, signal);
      completed(result, sttMaxTokens);
      if (!Array.isArray(result.steps)) throw new SpeechError("invalid_voice_response");
      let text = "";
      for (const step of result.steps) {
        if (!record(step) || step.type !== "model_output" || !Array.isArray(step.content))
          throw new SpeechError("invalid_voice_response");
        for (const content of step.content) {
          if (!record(content) || content.type !== "text" || typeof content.text !== "string")
            throw new SpeechError("invalid_voice_response");
          text += content.text;
        }
      }
      // 正常完了した空の文字起こしは発言なし。TTSの空入力やAPI異常とは区別する。
      text = text.trim();
      if (text.length > 1000) throw new SpeechError("invalid_voice_text");
      return { text };
    } catch (error) { throw safeError(error, signal); }
  }

  // 呼出側が根拠を検証した文章だけを渡す。音声用の回答生成や追加の検索は行わない。
  async *synthesize(text: string, signal: AbortSignal): AsyncGenerator<SpeechAudio> {
    if (this.ttsMode === "streaming") yield* this.synthesizeStreaming(text, signal);
    else yield* this.synthesizeBuffered(text, signal);
  }

  // 文章単位で生成を終えてから渡し、低速なdelta配信による再生の途切れを避ける。
  private async *synthesizeBuffered(text: string, signal: AbortSignal): AsyncGenerator<SpeechAudio> {
    try {
      const body = await this.request({
        model: this.ttsModel, input: textValue(text), stream: false,
        response_format: { type: "audio" },
        generation_config: { max_output_tokens: ttsMaxTokens, speech_config: [{ voice: this.voice }] }
      }, signal);
      const result = await readJson(body, signal, 3_500_000);
      completed(result, ttsMaxTokens);
      if (!Array.isArray(result.steps)) throw new SpeechError("invalid_voice_response");
      const audio: SpeechAudio[] = [];
      let receivedBytes = 0;
      for (const step of result.steps) {
        if (!record(step) || step.type !== "model_output" || !Array.isArray(step.content))
          throw new SpeechError("invalid_voice_response");
        const format: AudioFormat = {};
        for (const content of step.content) {
          if (!record(content)) throw new SpeechError("invalid_voice_audio");
          const data = content.data;
          if (data !== undefined && typeof data !== "string") throw new SpeechError("invalid_voice_audio");
          // base64の4文字境界で分け、最大96KBのPCMとして既存の再生経路へ渡す。
          const encoded = typeof data === "string" ? data : "";
          if (encoded.length % 4 || encoded.includes("=") && encoded.indexOf("=") < encoded.length - 2)
            throw new SpeechError("invalid_voice_audio");
          for (let offset = 0; offset < Math.max(1, encoded.length); offset += 128_000) {
            const parsed = audioChunk({ ...content, data: encoded.slice(offset, offset + 128_000) }, format);
            receivedBytes += parsed.bytes;
            if (receivedBytes > maxPcmBytes) throw new SpeechError("voice_audio_too_large");
            if (parsed.audio) audio.push(parsed.audio);
          }
        }
      }
      if (!receivedBytes) throw new SpeechError("voice_audio_missing");
      // 完了状態・形式・全体量を確認するまで、一部だけ成功として流さない。
      for (const chunk of audio) { signal.throwIfAborted(); yield chunk; }
    } catch (error) { throw safeError(error, signal); }
  }

  private async *synthesizeStreaming(text: string, signal: AbortSignal): AsyncGenerator<SpeechAudio> {
    try {
      signal.throwIfAborted();
      const body = await this.request({
        model: this.ttsModel, input: textValue(text), stream: true,
        // TTS専用APIの指定に従う。音声形式は返却metadataで検証する。
        response_format: { type: "audio" },
        generation_config: { max_output_tokens: ttsMaxTokens, speech_config: [{ voice: this.voice }] }
      }, signal, true);
      let started = false, finished = false, receivedBytes = 0, previousIndex = -1;
      let activeIndex: number | null = null;
      let format: AudioFormat = {};
      for await (const raw of readSse(boundedBody(body, 3_500_000, signal), signal)) {
        signal.throwIfAborted();
        if (raw.length > maxFrameChars) throw new SpeechError("voice_response_too_large");
        const event: unknown = JSON.parse(raw);
        if (!record(event) || typeof event.event_type !== "string") throw new SpeechError("invalid_voice_event");
        if (event.error != null || event.errors != null || event.event_type === "error") throw new SpeechError("voice_provider_error");
        const chunks: unknown[] = [];
        switch (event.event_type) {
          case "interaction.created":
            if (started || finished || !record(event.interaction) || event.interaction.status !== "in_progress")
              throw new SpeechError("invalid_voice_event");
            started = true;
            break;
          case "interaction.in_progress":
            if (!started || finished) throw new SpeechError("invalid_voice_event");
            break;
          case "interaction.status_update":
            if (!started || finished || (event.status !== "in_progress" && event.status !== "completed"))
              throw new SpeechError("voice_provider_incomplete");
            break;
          case "step.start": {
            const step = event.step;
            if (!started || finished || activeIndex !== null || typeof event.index !== "number" || !Number.isSafeInteger(event.index)
              || event.index <= previousIndex || !record(step) || step.type !== "model_output")
              throw new SpeechError("invalid_voice_event");
            activeIndex = event.index;
            format = {};
            if (step.content !== undefined) {
              if (!Array.isArray(step.content)) throw new SpeechError("invalid_voice_event");
              chunks.push(...step.content);
            }
            break;
          }
          case "step.delta":
            if (finished || activeIndex === null || event.index !== activeIndex) throw new SpeechError("invalid_voice_event");
            chunks.push(event.delta);
            break;
          case "step.stop":
            if (finished || activeIndex === null || event.index !== activeIndex) throw new SpeechError("invalid_voice_event");
            previousIndex = activeIndex;
            activeIndex = null;
            break;
          case "interaction.completed":
            if (!started || finished || activeIndex !== null) throw new SpeechError("voice_provider_incomplete");
            completed(event.interaction, ttsMaxTokens);
            finished = true;
            break;
          default:
            if (event.event_type.startsWith("interaction.")) throw new SpeechError("voice_provider_incomplete");
            if (event.event_type.startsWith("step.")) throw new SpeechError("invalid_voice_event");
            // pingや将来追加されるメタデータを音声へ混ぜない。
            continue;
        }
        for (const chunk of chunks) {
          const parsed = audioChunk(chunk, format);
          receivedBytes += parsed.bytes;
          if (receivedBytes > maxPcmBytes) throw new SpeechError("voice_audio_too_large");
          if (parsed.audio) yield parsed.audio;
        }
      }
      signal.throwIfAborted();
      if (!finished) throw new SpeechError("voice_provider_incomplete");
      if (!receivedBytes) throw new SpeechError("voice_audio_missing");
    } catch (error) { throw safeError(error, signal); }
  }
}
