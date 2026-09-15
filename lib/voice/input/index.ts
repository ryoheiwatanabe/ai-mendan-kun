import { ServerRecognizer } from "./server.ts";
import { WebSpeechRecognizer } from "./webspeech.ts";
import type { InputRecognizer, RecognitionMode, RecognizerCallbacks, SpeechRecognitionConstructor } from "./types.ts";

// 選んだ方式の認識器を作る。手入力は音声を使わないため、認識器を持たない。
export function createRecognizer(mode: RecognitionMode, options: {
  callbacks: RecognizerCallbacks; constructor: SpeechRecognitionConstructor | null;
}): InputRecognizer | null {
  if (mode === "manual") return null;
  if (mode === "server") return new ServerRecognizer();
  if (!options.constructor) throw new Error("recognition_unsupported");
  return new WebSpeechRecognizer({ mode, constructor: options.constructor, callbacks: options.callbacks });
}

export { detectRecognitionSupport, installJapanesePack, recognitionConstructor } from "./probe.ts";
export { preferredMode, usableModes } from "./select.ts";
export { recognitionLabels } from "./types.ts";
export type {
  InputRecognizer, RecognitionAvailability, RecognitionFailure, RecognitionLocation, RecognitionMode,
  RecognitionSupport, RecognizerCallbacks, SpeechRecognitionConstructor
} from "./types.ts";
