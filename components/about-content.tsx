import type { VoiceConfiguration } from "../lib/voice/types.ts";
import { ConversationStorageDescription } from "./test-recording";

export function AboutContent({ processors, voice }: { processors: string; voice?: VoiceConfiguration | null }) {
  return <div className="about-copy">
    <p>AI面談くんは、本人との面談に向けて、経歴や考え方への理解を深めるための対話窓口です。</p>
    <h2>本人が確認した記録から答えます。</h2><p>回答には公開用に承認された情報を使います。関連する記録があっても、質問への答えが分からない場合はその旨をお伝えします。AIの解釈を含む場合は区別して表示します。重要な事実や条件は、面談で本人にも確認してください。</p>
    <h2>意思決定は本人が行います。</h2><p>AIの回答は本人のリアルタイムの発言ではありません。入社・参加・契約条件への承諾を代行しません。この文字版には、本人へ質問を送る機能はありません。</p>
    <ConversationStorageDescription processors={voice?.enabled ? voice.processors : processors} />
    {voice?.enabled && <><h2>音声も、同じ記録から答えます。</h2><p>音声の文字起こし方法は開始前に選びます。GoogleのGemini APIを選ぶ場合は録音をGoogleへ送り、端末内の認識を選ぶ場合は端末で処理します。ブラウザー提供元の認識では、その提供元の外部サービスで処理します。読み上げを有効にした場合は、確認済みの回答文をGemini APIへ送って音声にします。{voice.voiceName}を使用し、本人の声を再現したものではありません。通常の公開版では録音と生成音声をアプリへ永続保存しません。Geminiの音声APIには提供元での会話保存を無効にする設定を指定します。外部サービス側の保持条件は提供元のポリシーに従います。</p></>}
  </div>;
}
