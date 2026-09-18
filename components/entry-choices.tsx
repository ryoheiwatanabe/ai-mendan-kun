"use client";

// 入口はテキスト・音声・動画（カミングスーン）の3つだけ。ここで会話モードを選び直させない。
// 音声用の設定取得は行わない。音声サービスが不調でも、テキストの入口を塞がない。
export function EntryChoices({ onText }: { onText: () => void }) {
  return <div className="entry-choices" role="group" aria-label="面談の入口">
    <button type="button" className="primary-button" onClick={onText}>テキストはこちら <span aria-hidden="true">→</span></button>
    <a className="entry-choice" href="/voice">音声はこちら <span aria-hidden="true">→</span></a>
    <button type="button" className="entry-choice" disabled>動画はこちら <span className="entry-coming">カミングスーン</span></button>
    <p className="input-note">動画の面談は準備中です。いまはテキストと音声をご利用いただけます。</p>
  </div>;
}
