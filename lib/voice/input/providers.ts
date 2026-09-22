// 表示専用の識別。認識機能の可否はprobe.tsでAPIに問い合わせる。
// Chrome系というだけでGoogleへ送られると断定しない。
type BrowserIdentity = {
  userAgent?: string;
  vendor?: string;
  userAgentData?: { brands: readonly { brand: string; version?: string }[] };
};

export function browserSpeechProvider(browser: BrowserIdentity = {}) {
  const brands = browser.userAgentData?.brands.map(item => item.brand) ?? [];
  const ua = browser.userAgent ?? "";
  const chrome = brands.includes("Google Chrome");
  const edge = brands.includes("Microsoft Edge") || /Edg\//.test(ua);
  const safari = browser.vendor === "Apple Computer, Inc." && /Version\/.*Safari\//.test(ua)
    && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  const provider = edge ? "Microsoft（Azureの音声認識）" : chrome ? "Google（Chromeの音声認識）"
    : safari ? "Apple（Safariの音声認識）" : "ブラウザー提供元（名称を確認できません）";
  const recipient = edge ? "Microsoft Azure" : chrome ? "Google" : safari ? "Apple" : "ブラウザー提供元のサービス";
  return {
    provider,
    note: `追加ダウンロードは不要です。音声が${recipient}へ送信される場合があります。`,
    packSource: chrome && !edge
      ? "提供・管理：Google（Google Chromeの音声認識用データ）"
      : "管理：お使いのブラウザー。配布元名はこの画面から確認できません。会社の端末では管理者に確認してください。",
    packSourceUrl: chrome && !edge ? "https://developer.chrome.com/blog/new-in-chrome-139#on-device_web_speech_api" : null
  };
}
