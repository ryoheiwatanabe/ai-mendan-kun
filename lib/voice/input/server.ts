import { recordingFetch } from "../../test-recording.ts";
import type { InputRecognizer, RecognitionLocation, RecognitionMode } from "./types.ts";

// 従来の方式。録音したPCM16 WAVをサーバーへ送り、サーバー側のSTTで文字にする。
export class ServerRecognizer implements InputRecognizer {
  readonly mode: RecognitionMode = "server";
  readonly location: RecognitionLocation = "external";
  readonly needsAudio = true;
  private fetchImpl: (input: string, init: RequestInit) => Promise<Response>;
  constructor(fetchImpl: (input: string, init: RequestInit) => Promise<Response> = recordingFetch) {
    this.fetchImpl = fetchImpl;
  }

  async prepare(): Promise<number> { return 0; }
  begin(): void {}

  async finish(_utteranceId: string, wav: ArrayBuffer | null, signal: AbortSignal): Promise<string> {
    if (!wav) throw new Error("transcription_failed");
    const response = await this.fetchImpl("/api/voice/transcribe", {
      method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav, signal
    });
    if (response.status === 429) throw new Error("transcription_limit");
    if (!response.ok) throw new Error("transcription_failed");
    const result: unknown = await response.json();
    if (!result || typeof result !== "object" || !("text" in result) || typeof (result as { text: unknown }).text !== "string")
      throw new Error("invalid_transcription");
    const text = (result as { text: string }).text.trim();
    if (text.length > 1000) throw new Error("invalid_transcription");
    return text;
  }

  discard(): void {}
  close(): void {}
}
