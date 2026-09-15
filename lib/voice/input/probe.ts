import type { RecognitionAvailability, RecognitionScope, RecognitionSupport, SpeechRecognitionConstructor } from "./types.ts";

export function recognitionConstructor(scope: RecognitionScope = globalThis as RecognitionScope): SpeechRecognitionConstructor | null {
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

function toAvailability(value: unknown): RecognitionAvailability {
  return value === "available" || value === "downloadable" || value === "unavailable" ? value : "unknown";
}

// ブラウザー名では判断しない。APIの対応状況と日本語(ja-JP)の利用可否をAPIへ問い合わせる。
// available()が無い環境(Safari等)は端末内を確認できないため、unavailableとして扱いクラウドはunknownに留める。
export async function detectRecognitionSupport(scope: RecognitionScope = globalThis as RecognitionScope): Promise<RecognitionSupport> {
  const constructor = recognitionConstructor(scope);
  if (!constructor) return { onDevice: "unavailable", browserCloud: "unavailable", packInstallable: false };
  const available = constructor.available?.bind(constructor);
  if (!available) return { onDevice: "unavailable", browserCloud: "unknown", packInstallable: typeof constructor.install === "function" };
  const ask = async (options: { langs: string[]; processLocally?: boolean }): Promise<RecognitionAvailability> => {
    try { return toAvailability(await available(options)); } catch { return "unavailable"; }
  };
  const [onDevice, browserCloud] = await Promise.all([
    ask({ langs: ["ja-JP"], processLocally: true }),
    ask({ langs: ["ja-JP"] })
  ]);
  return { onDevice, browserCloud, packInstallable: typeof constructor.install === "function" };
}

// 利用者へ案内して同意を得た後だけ呼ぶ。端末内認識の日本語パックを追加する。
export async function installJapanesePack(scope: RecognitionScope = globalThis as RecognitionScope): Promise<boolean> {
  const constructor = recognitionConstructor(scope);
  const install = constructor?.install?.bind(constructor);
  if (!install) return false;
  try { return await install({ langs: ["ja-JP"] }) === true; } catch { return false; }
}
