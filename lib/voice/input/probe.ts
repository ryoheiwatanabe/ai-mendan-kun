import type { RecognitionAvailability, RecognitionScope, RecognitionSupport, SpeechRecognitionConstructor,
  SpeechRecognitionPhraseLike } from "./types.ts";

export function recognitionConstructor(scope: RecognitionScope = globalThis as RecognitionScope): SpeechRecognitionConstructor | null {
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

// 実験的な phrases は、対応する環境だけ使う。未対応・例外なら従来の認識へ戻す。
export function speechPhraseFactory(scope: RecognitionScope = globalThis as RecognitionScope):
  ((phrase: string, boost: number) => SpeechRecognitionPhraseLike) | null {
  const Constructor = scope.SpeechRecognitionPhrase;
  if (typeof Constructor !== "function") return null;
  return (phrase, boost) => new Constructor(phrase, boost);
}

function toAvailability(value: unknown): RecognitionAvailability {
  return value === "available" || value === "downloadable" || value === "downloading" || value === "unavailable" ? value : "unknown";
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
// 失敗を区別し、追加できないブラウザーで再試行だけを促さない。例外名は診断用に返す。
export type PackInstallOutcome = { status: "installed" | "unsupported" | "failed"; error?: string };
export async function installJapanesePack(scope: RecognitionScope = globalThis as RecognitionScope): Promise<PackInstallOutcome> {
  const constructor = recognitionConstructor(scope);
  const install = constructor?.install?.bind(constructor);
  if (!install) return { status: "unsupported" };
  try {
    // processLocallyを渡さないと、Chromeは何もせずfalseを返す。
    return await install({ langs: ["ja-JP"], processLocally: true }) === true ? { status: "installed" } : { status: "failed" };
  } catch (error) {
    const name = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "";
    return { status: "failed", ...(name ? { error: name } : {}) };
  }
}
