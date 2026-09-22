import { VoiceChat } from "../../components/voice-chat.tsx";
import { AboutDialog } from "../../components/about-dialog";
import { getProcessorNames } from "../../lib/runtime.ts";
import "./voice.css";

export const dynamic = "force-dynamic";

export default async function VoicePage() {
  const processors = await getProcessorNames();
  return <main className="shell voice-shell conversation-shell">
    <header className="masthead"><a className="wordmark" href="/" aria-label="AI面談くん ホーム"><span className="brand-mark" aria-hidden="true">面</span>AI面談くん</a><a className="text-link" href="/">文字で話す <span aria-hidden="true">↗</span></a></header>
    <h1 className="sr-only">音声AI面談</h1>
    <div className="workspace voice-workspace conversation-workspace">
      <VoiceChat />
    </div>
    <footer className="footer"><span>本人のリアルタイムの発言ではありません。大切な条件や判断は、面談で本人にご確認ください。</span><AboutDialog processors={processors} /></footer>
  </main>;
}
