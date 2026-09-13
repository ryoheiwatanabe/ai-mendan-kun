import Link from "next/link";
import { getProcessorNames } from "../../lib/runtime.ts";
import { getVoiceConfiguration } from "../../lib/voice/runtime.ts";
import { ConversationStorageDescription } from "../../components/test-recording";

export const dynamic = "force-dynamic";
export default async function About() {
  const [textProcessors, voice] = await Promise.all([getProcessorNames(), getVoiceConfiguration()]);
  const processors = voice.enabled ? voice.processors : textProcessors;
  return <main className="about-page"><Link className="text-link" href="/">← 面談へ戻る</Link><h1>このAIについて</h1>
    <p>AI面談くんは、本人との面談に向けて、経歴や考え方への理解を深めるための対話窓口です。</p>
    <h2>本人が確認した記録から答えます。</h2><p>回答には公開用に承認された情報を使います。関連する記録があっても、質問への答えが分からない場合はその旨をお伝えします。AIの解釈を含む場合は区別して表示します。重要な事実や条件は、面談で本人にも確認してください。</p>
    <h2>意思決定は本人が行います。</h2><p>AIの回答は本人のリアルタイムの発言ではありません。入社・参加・契約条件への承諾を代行しません。この文字版には、本人へ質問を送る機能はありません。</p>
    <ConversationStorageDescription processors={processors} />
    {voice.enabled && <><h2>音声も、同じ記録から答えます。</h2><p>音声面談では、録音を文字にするためGoogleのGemini APIへ送り、確認済みの回答文を同じAPIで音声にします。{voice.voiceName}を使用し、本人の声を再現したものではありません。通常の公開版では録音と生成音声をアプリへ永続保存しません。検証記録の有無にかかわらず、音声APIには提供元での会話保存を無効にする設定を指定します。外部サービス側の保持条件は提供元のポリシーに従います。</p></>}
    <Link className="primary-button" href="/">AI面談をはじめる <span aria-hidden="true">→</span></Link>
  </main>;
}
