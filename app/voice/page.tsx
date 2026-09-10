import { VoiceChat } from "../../components/voice-chat.tsx";
import "./voice.css";

export default function VoicePage() {
  return <main className="shell voice-shell">
    <header className="masthead"><a className="wordmark" href="/" aria-label="AI面談くん ホーム"><span className="brand-mark" aria-hidden="true">面</span>AI面談くん</a><a className="text-link" href="/">文字で話す <span aria-hidden="true">↗</span></a></header>
    <div className="workspace voice-workspace">
      <aside className="intro"><div className="intro-main"><p className="intro-caption">面談までの、もうひとつの対話。</p><h1>声にすると、<br />話がひらく。</h1><p className="intro-copy">気になることを、いつもの言葉で。<br />本人が確認した情報をもとに、<br />AIが声でお答えします。</p></div><div className="intro-note"><span className="note-mark" aria-hidden="true">＊</span><p>相槌も、途中からの質問も。<br />あなたのペースで話してください。</p></div></aside>
      <VoiceChat />
    </div>
    <footer className="footer"><span>本人のリアルタイムの発言ではありません。大切な条件や判断は、面談で本人にご確認ください。</span><a href="/about">このAIについて</a></footer>
  </main>;
}
