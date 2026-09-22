import type { RecognitionMode, RecognitionSupport } from "./types.ts";

// 追加ダウンロードなしのブラウザー認識を優先し、初期選択を必ず先頭に置く。
// 選択操作では並べ替えず、開始後の別方式への切り替えは利用者に選んでもらう。
export function usableModes(support: RecognitionSupport, serverAvailable: boolean): RecognitionMode[] {
  const modes: RecognitionMode[] = [];
  if (support.browserCloud !== "unavailable") modes.push("browser-cloud");
  if (support.onDevice === "available") modes.push("on-device");
  if (serverAvailable) modes.push("server");
  modes.push("manual");
  return modes;
}

export function preferredMode(support: RecognitionSupport, serverAvailable: boolean, chosen: RecognitionMode | null = null): RecognitionMode {
  const modes = usableModes(support, serverAvailable);
  if (chosen && modes.includes(chosen)) return chosen;
  return modes[0];
}
