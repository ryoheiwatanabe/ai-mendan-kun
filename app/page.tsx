import { Chat } from "../components/chat.tsx";
import { VoiceEntry } from "../components/voice-entry.tsx";

export default function Page() {
  return <main className="shell">
    <header className="masthead"><a className="wordmark" href="/" aria-label="AI面談くん ホーム"><span className="brand-mark" aria-hidden="true">面</span>AI面談くん</a><a href="/about" className="text-link">このAIについて <span aria-hidden="true">↗</span></a></header>
    <div className="workspace">
      <aside className="intro">
        <div className="intro-main"><p className="intro-caption">面談までの、もうひとつの対話。</p><h1>会う前に、<br />少し話そう。</h1><p className="intro-copy">経歴だけでは、伝わらないこと。<br />任せたい仕事や、気になる考え方。<br />本人の記録をもとに、AIがお答えします。</p><VoiceEntry /></div>
        <div className="intro-note"><span className="note-mark" aria-hidden="true">＊</span><p>ここで見つかった疑問が、<br />当日の会話のきっかけになれば。</p></div>
      </aside>
      <Chat />
    </div>
    <footer className="footer"><span>AIとの事前対話です。本人のリアルタイムの発言ではありません。</span><span>AI面談くん</span></footer>
  </main>;
}
