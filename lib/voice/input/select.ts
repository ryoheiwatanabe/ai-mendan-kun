import type { RecognitionMode, RecognitionSupport } from "./types.ts";

// 端末内が使えるなら端末内を既定にする。使えない場合は、選ぶまで従来の方式を提示して黙って切り替えない。
export function usableModes(support: RecognitionSupport, serverAvailable: boolean): RecognitionMode[] {
  const modes: RecognitionMode[] = [];
  if (support.onDevice === "available") modes.push("on-device");
  if (support.browserCloud !== "unavailable") modes.push("browser-cloud");
  if (serverAvailable) modes.push("server");
  modes.push("manual");
  return modes;
}

export function preferredMode(support: RecognitionSupport, serverAvailable: boolean, chosen: RecognitionMode | null = null): RecognitionMode {
  const modes = usableModes(support, serverAvailable);
  if (chosen && modes.includes(chosen)) return chosen;
  if (support.onDevice === "available") return "on-device";
  if (serverAvailable) return "server";
  if (support.browserCloud !== "unavailable") return "browser-cloud";
  return "manual";
}
