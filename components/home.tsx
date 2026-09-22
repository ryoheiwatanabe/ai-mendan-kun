import { Chat } from "./chat.tsx";
import { AboutDialog } from "./about-dialog";

export function Home({ processors }: { processors: string }) {
  return <main className="shell conversation-shell">
    <header className="masthead"><span className="wordmark"><span className="brand-mark" aria-hidden="true">面</span>AI面談くん</span><AboutDialog processors={processors} /></header>
    <h1 className="sr-only">AI面談くん</h1>
    <div className="workspace conversation-workspace">
      <Chat processors={processors} />
    </div>
    <footer className="footer"><span>AIとの事前対話です。本人のリアルタイムの発言ではありません。</span><span>AI面談くん</span></footer>
  </main>;
}
