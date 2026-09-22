import type { Metadata } from "next";
import Link from "next/link";
import { JevSettingsPanel } from "../../components/jev-settings-panel";

// 検索結果へ出さない。鍵がなければ読み書きできない。
export const metadata: Metadata = { title: "回答の採点設定 | AI面談くん", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default function Admin() {
  return <main className="admin-page"><Link className="text-link" href="/">← 面談へ戻る</Link>
    <h1>回答の採点設定</h1>
    <p className="input-note">本人専用の画面です。保存した設定は、次の質問から文字・音声の両方に反映されます。</p>
    <p className="input-note">生の内省メモを公開用の知識カードへ整えるときは <Link className="text-link" href="/admin/intake">公開用資料を整える →</Link></p>
    <JevSettingsPanel />
  </main>;
}
