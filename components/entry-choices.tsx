"use client";

// 入口はチャット・音声・動画（Coming Soon）の3つだけ。ここで会話モードを選び直させない。
// 音声用の設定取得は行わない。音声サービスが不調でも、テキストの入口を塞がない。
export function EntryChoices({ onText }: { onText: () => void }) {
  return <div className="entry-choices" role="group" aria-label="面談の入口">
    <button type="button" className="entry-choice entry-choice-primary" onClick={onText}><span>チャット版はこちら</span><span aria-hidden="true">→</span></button>
    <a className="entry-choice" href="/voice"><span>音声版はこちら</span><span aria-hidden="true">→</span></a>
    <button type="button" className="entry-choice" disabled><span>動画版はこちら</span><span>Coming Soon</span></button>
  </div>;
}
